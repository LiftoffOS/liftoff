// src/scheduling/memory-summarization-loop.ts
// Per-tenant daily summarization. Runs once per tenant per 24h via Cloud Tasks
// fan-out (separate scheduler from per-agent consolidation).

import { createHash } from 'crypto';
import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { llmClient } from '../llm/client';
import type { LLMProvider } from '../llm/types';
import { generateEmbeddingDetailed, getDefaultProvider, getProviderModel } from '../memory/embedding';
import { sanitizeMemoryContent } from '../memory/content-sanitizer';
import * as provenanceService from '../memory/provenance-service';
import { getEntitlementsClient, isExecutionAllowed } from '../entitlements-client/service';
import { incCounter, observeHistogram, HISTOGRAM_BUCKETS } from '../memory/metrics';

const MIN_GROUP_SIZE = 3;
const MAX_GROUP_SIZE = 15;
const MIN_AVG_INFLUENCE = 0.3;

// Resolved at invocation time so feature flag toggles take effect without restart.
function isEnabled(): boolean {
  return process.env.MEM_SUMMARIZATION_ENABLED === '1';
}

// BILLING-GATE: summarization is invisible background work that calls the LLM
// and drains the tenant's Operating Units. A suspended / not-execution-allowed
// tenant must not accrue new drain — mirror the L3 entitlement gate that
// scheduled agent execution already enforces (scheduled-invoke-handler). This
// is the missing L3 check for the memory-maintenance loops (the L2 kill-switch
// deliberately skips these endpoints, so without this they would run for
// suspended tenants).
async function tenantExecutionAllowed(tenantId: string, loop: string): Promise<boolean> {
  const allowed = await isExecutionAllowed(tenantId);
  if (!allowed) {
    logger.info({ tenantId, loop }, 'memory-summarization-loop: skipped (tenant not execution-allowed / suspended)');
  }
  return allowed;
}

export async function runDailySummarization(tenantId: string): Promise<{ summaries: number; superseded: number }> {
  if (!isEnabled()) {
    logger.info({ tenantId }, 'memory-summarization-loop: disabled (MEM_SUMMARIZATION_ENABLED!=1)');
    return { summaries: 0, superseded: 0 };
  }
  if (!(await tenantExecutionAllowed(tenantId, 'daily'))) {
    return { summaries: 0, superseded: 0 };
  }
  const pool = getPoolForService('scheduled-execution');

  // Advisory lock per tenant — namespace 1 to avoid collision with consolidation (namespace 0).
  const lock = await pool.query<{ acquired: boolean }>(
    `SELECT pg_try_advisory_lock(hashtextextended($1, 1)) AS acquired`,
    [tenantId],
  );
  if (!lock.rows[0]?.acquired) return { summaries: 0, superseded: 0 };

  try {
    return await runDailySummarizationInner(tenantId, pool);
  } finally {
    await pool.query(`SELECT pg_advisory_unlock(hashtextextended($1, 1))`, [tenantId]);
  }
}

async function runDailySummarizationInner(tenantId: string, pool: any) {
  const rows = await pool.query(
    `SELECT id, content, tags, usefulness_score, importance_score,
            influence_score, source_trust, created_at, agent_id, layer
     FROM memories
     WHERE tenant_id = $1
       AND summary_level = 0
       AND superseded_by IS NULL
       AND content_classification NOT IN ('pii', 'sensitive')
       AND created_at >= CURRENT_DATE - INTERVAL '1 day'
       AND created_at <  CURRENT_DATE
     ORDER BY influence_score DESC`,
    [tenantId],
  );

  if (rows.rows.length < MIN_GROUP_SIZE) return { summaries: 0, superseded: 0 };

  const groups = groupByPrimaryTag(rows.rows);

  let summariesWritten = 0;
  for (const [primaryTag, memories] of groups) {
    if (memories.length < MIN_GROUP_SIZE) continue;
    const avgInfluence = memories.reduce((s: number, m: any) => s + parseFloat(m.influence_score ?? '0.5'), 0) / memories.length;
    if (avgInfluence < MIN_AVG_INFLUENCE) continue;

    const capped = memories.slice(0, MAX_GROUP_SIZE);
    observeHistogram('memory_summary_group_size', capped.length, { __name: 'memory_summary_group_size', tier: 'l1' }, HISTOGRAM_BUCKETS.SIZE);
    const summary = await llmSummarizeGroup(capped.map((m: any) => m.content), tenantId, primaryTag).catch(() => null);
    if (!summary) continue;

    const { sanitized } = sanitizeMemoryContent(summary);
    if (!sanitized || sanitized.length < 20) continue;

    const contentHash = createHash('sha256').update(sanitized).digest('hex');
    const embedResult = await generateEmbeddingDetailed(sanitized, {
      tenantId,
      purpose: 'summarization_l1',
      taskType: 'retrieval_document',
    }).catch(() => null);
    const embedding = embedResult?.embedding ?? null;
    const embeddingModel = embedResult?.model ?? getProviderModel(getDefaultProvider());
    const maxUsefulness = Math.max(...capped.map((m: any) => m.usefulness_score));
    const maxSourceTrust = Math.max(...capped.map((m: any) => parseFloat(m.source_trust ?? '0.5')));
    const unionTags = [...new Set([...capped.flatMap((m: any) => m.tags || []), 'summary-l1', `topic:${primaryTag}`])];
    const memberIds = capped.map((m: any) => m.id);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const insertResult = await client.query(
        `INSERT INTO memories (
           tenant_id, layer, scope_key, content, content_hash,
           embedding, embedding_model, content_classification,
           usefulness_score, importance_score, tags,
           source_trust, summary_level, summarizes, expires_at)
         VALUES ($1, 'global', 'summary-l1', $2, $3, $4, $5, 'internal',
                 $6, 3, $7, $8, 1, $9, NULL)
         RETURNING id`,
        [tenantId, sanitized, contentHash,
         embedding ? JSON.stringify(embedding) : null, embeddingModel,
         maxUsefulness, unionTags, maxSourceTrust, memberIds],
      );
      const summaryId = insertResult.rows[0].id;

      await provenanceService.recordSynthesis(client, tenantId, memberIds, summaryId);

      await client.query('COMMIT');
      summariesWritten++;
      // tenantId stays off the labels (it would grow the process-local
      // accumulator one entry per tenant, forever) and on the log lines around it.
      incCounter('memory_l1_summaries_written_total', { __name: 'memory_l1_summaries_written_total' });
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ tenantId, primaryTag, err: (err as Error).message }, 'l1-summarization transaction failed');
    } finally {
      client.release();
    }
  }

  // Supersede L0 memories that have been covered by an L1 summary for ≥30 days
  const supersedeResult = await pool.query(
    `WITH covered AS (
       SELECT s.id AS summary_id, unnest(s.summarizes) AS covered_id
       FROM memories s
       WHERE s.tenant_id = $1
         AND s.summary_level = 1
         AND s.created_at < NOW() - INTERVAL '30 days'
         AND s.superseded_by IS NULL
     )
     UPDATE memories m
     SET superseded_by = covered.summary_id,
         superseded_at = NOW(),
         supersession_reason = 'summarized-to-l1'
     FROM covered
     WHERE m.id = covered.covered_id
       AND m.tenant_id = $1
       AND m.superseded_by IS NULL
       AND m.summary_level = 0
     RETURNING m.id`,
    [tenantId],
  );

  const supersededCount = supersedeResult.rowCount ?? 0;
  if (supersededCount > 0) {
    incCounter('memory_l0_superseded_by_summary_total', { __name: 'memory_l0_superseded_by_summary_total' }, supersededCount);
    logger.info({ tenantId, supersededCount }, 'l0 memories superseded by an l1 summary');
  }

  return { summaries: summariesWritten, superseded: supersededCount };
}

export async function runWeeklySummarization(tenantId: string): Promise<{ summaries: number; superseded: number }> {
  if (!isEnabled()) {
    logger.info({ tenantId }, 'memory-summarization-loop: weekly disabled');
    return { summaries: 0, superseded: 0 };
  }
  if (!(await tenantExecutionAllowed(tenantId, 'weekly'))) {
    return { summaries: 0, superseded: 0 };
  }
  const pool = getPoolForService('scheduled-execution');

  const lock = await pool.query<{ acquired: boolean }>(
    `SELECT pg_try_advisory_lock(hashtextextended($1, 2)) AS acquired`,
    [tenantId],
  );
  if (!lock.rows[0]?.acquired) return { summaries: 0, superseded: 0 };

  try {
    return await runWeeklySummarizationInner(tenantId, pool);
  } finally {
    await pool.query(`SELECT pg_advisory_unlock(hashtextextended($1, 2))`, [tenantId]);
  }
}

async function runWeeklySummarizationInner(tenantId: string, pool: any) {
  const rows = await pool.query(
    `SELECT id, content, tags, usefulness_score, importance_score,
            influence_score, source_trust, created_at, agent_id, layer
     FROM memories
     WHERE tenant_id = $1
       AND summary_level = 1
       AND superseded_by IS NULL
       AND content_classification NOT IN ('pii', 'sensitive')
       AND created_at >= CURRENT_DATE - INTERVAL '7 days'
       AND created_at <  CURRENT_DATE
     ORDER BY influence_score DESC`,
    [tenantId],
  );

  if (rows.rows.length < MIN_GROUP_SIZE) return { summaries: 0, superseded: 0 };

  // Group by topic:* tag rather than primary tag
  const groups = new Map<string, any[]>();
  for (const row of rows.rows) {
    const tags = (row.tags || []) as string[];
    const topic = tags.find(t => t.startsWith('topic:')) ?? 'topic:untagged';
    const list = groups.get(topic) ?? [];
    list.push(row);
    groups.set(topic, list);
  }

  let summariesWritten = 0;
  for (const [topic, memories] of groups) {
    if (memories.length < MIN_GROUP_SIZE) continue;
    const avgInfluence = memories.reduce((s: number, m: any) => s + parseFloat(m.influence_score ?? '0.5'), 0) / memories.length;
    if (avgInfluence < MIN_AVG_INFLUENCE) continue;

    const capped = memories.slice(0, MAX_GROUP_SIZE);
    const summary = await llmSummarizeGroup(capped.map((m: any) => m.content), tenantId, topic).catch(() => null);
    if (!summary) continue;

    const { sanitized } = sanitizeMemoryContent(summary);
    if (!sanitized || sanitized.length < 20) continue;

    const contentHash = createHash('sha256').update(sanitized).digest('hex');
    const embedResult = await generateEmbeddingDetailed(sanitized, {
      tenantId,
      purpose: 'summarization_l2',
      taskType: 'retrieval_document',
    }).catch(() => null);
    const embedding = embedResult?.embedding ?? null;
    const embeddingModel = embedResult?.model ?? getProviderModel(getDefaultProvider());
    const maxUsefulness = Math.max(...capped.map((m: any) => m.usefulness_score));
    const maxSourceTrust = Math.max(...capped.map((m: any) => parseFloat(m.source_trust ?? '0.5')));
    const unionTags = [...new Set([...capped.flatMap((m: any) => m.tags || []), 'summary-l2', topic])];
    const memberIds = capped.map((m: any) => m.id);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const insertResult = await client.query(
        `INSERT INTO memories (
           tenant_id, layer, scope_key, content, content_hash,
           embedding, embedding_model, content_classification,
           usefulness_score, importance_score, tags,
           source_trust, summary_level, summarizes, expires_at)
         VALUES ($1, 'global', 'summary-l2', $2, $3, $4, $5, 'internal',
                 $6, 3, $7, $8, 2, $9, NULL)
         RETURNING id`,
        [tenantId, sanitized, contentHash,
         embedding ? JSON.stringify(embedding) : null, embeddingModel,
         maxUsefulness, unionTags, maxSourceTrust, memberIds],
      );
      const summaryId = insertResult.rows[0].id;
      await provenanceService.recordSynthesis(client, tenantId, memberIds, summaryId);
      await client.query('COMMIT');
      summariesWritten++;
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ tenantId, topic, err: (err as Error).message }, 'l2-summarization transaction failed');
    } finally {
      client.release();
    }
  }

  const supersedeResult = await pool.query(
    `WITH covered AS (
       SELECT s.id AS summary_id, unnest(s.summarizes) AS covered_id
       FROM memories s
       WHERE s.tenant_id = $1
         AND s.summary_level = 2
         AND s.created_at < NOW() - INTERVAL '90 days'
         AND s.superseded_by IS NULL
     )
     UPDATE memories m
     SET superseded_by = covered.summary_id,
         superseded_at = NOW(),
         supersession_reason = 'summarized-to-l2'
     FROM covered
     WHERE m.id = covered.covered_id
       AND m.tenant_id = $1
       AND m.superseded_by IS NULL
       AND m.summary_level = 1
     RETURNING m.id`,
    [tenantId],
  );

  return { summaries: summariesWritten, superseded: supersedeResult.rowCount ?? 0 };
}

function groupByPrimaryTag(rows: any[]): Map<string, any[]> {
  const out = new Map<string, any[]>();
  for (const row of rows) {
    const tags = (row.tags || []) as string[];
    const primary = tags.find(t => t.startsWith('type:') || t.startsWith('harvest:entity:')) ?? tags[0] ?? 'untagged';
    const list = out.get(primary) ?? [];
    list.push(row);
    out.set(primary, list);
  }
  return out;
}

async function llmSummarizeGroup(contents: string[], tenantId: string, topic: string): Promise<string> {
  const taskConfig = await getEntitlementsClient().getModelForTask(tenantId, 'memory_summarization');
  const response = await llmClient.complete(
    {
      messages: [
        { role: 'system', content: `Summarize these related operational memories about "${topic}" into a single coherent paragraph (≤200 words). Do NOT add information not present. Combine specifics where they reinforce each other. Keep numbers, identifiers, thresholds. Write in second person.` },
        { role: 'user', content: contents.map((c, i) => `${i + 1}. ${c}`).join('\n') },
      ],
      maxTokens: 600,
      temperature: 0.1,
    },
    llmClient.modelSelectionFor(taskConfig),
    { tenantId, purpose: 'memory_summarization' },
  );
  return response.content;
}
