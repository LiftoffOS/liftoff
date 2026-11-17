// Memory Consolidation + CLAUDE.md Graduation Loop
//
// Periodic job (12h default) that:
// 1. Consolidates related auto-reflection memories (LLM groups → code selects → LLM rewrites)
// 2. Graduates validated memories to CLAUDE.md (learned_instructions_md)
//
// Uses Cloud Tasks fan-out for reliable execution (not setInterval).
// Advisory lock per agent prevents duplicate processing across instances.
// All consolidation writes are atomic (single DB transaction).

import { createHash } from 'crypto';
import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import * as provenanceService from '../memory/provenance-service';
import { llmClient } from '../llm/client';
import { getEntitlementsClient, isExecutionAllowed } from '../entitlements-client/service';
import type { LLMProvider } from '../llm/types';
import { generateEmbeddingDetailed, getDefaultProvider, getProviderModel } from '../memory/embedding';
import { sanitizeMemoryContent } from '../memory/content-sanitizer';
import { setGauge } from '../memory/metrics';
import type { Clock } from '../test-utils/clock';
import { systemClock } from '../test-utils/clock';

const MAX_GROUP_SIZE = 5;
const MIN_MEMORIES_FOR_CONSOLIDATION = 5;
const MAX_CLAUDE_MD_BULLETS = 10;
const MAX_BULLET_LENGTH = 200;
const GRADUATION_MIN_AGE_DAYS = 7;
const GRADUATION_MIN_USEFULNESS = 3;

// --- Entry point: called by Cloud Tasks handler ---

export async function runConsolidationForAgent(
  tenantId: string,
  agentId: string,
  clock: Clock = systemClock,
): Promise<{ consolidated: number; graduated: number }> {
  // BILLING-GATE: consolidation is invisible background work that calls the
  // LLM (group + rewrite) and drains the tenant's Operating Units. A suspended
  // / not-execution-allowed tenant must not accrue new drain — the L3 gate that
  // scheduled agent execution enforces is otherwise missing for this loop, and
  // the consolidation-tick entry point is not protected by the L2 kill-switch.
  if (!(await isExecutionAllowed(tenantId))) {
    logger.info({ tenantId, agentId }, 'consolidation-loop: skipped (tenant not execution-allowed / suspended)');
    return { consolidated: 0, graduated: 0 };
  }

  const pool = getPoolForService('scheduled-execution');
  const now = new Date(clock());

  // Advisory lock — skip if another instance is already processing this agent
  const lockResult = await pool.query(
    `SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired`,
    [agentId],
  );
  if (!lockResult.rows[0]?.acquired) {
    logger.info({ agentId }, 'consolidation-loop: skipping (advisory lock held by another instance)');
    return { consolidated: 0, graduated: 0 };
  }

  try {
    // Change B: rollup + recompute (per-tenant; guarded by 11h interval inside)
    const { rollupYesterday, recomputeInfluenceScores } = await import('../memory/influence-calculator');
    await rollupYesterday(tenantId).catch(err =>
      logger.warn({ tenantId, err: (err as Error).message }, 'rollup failed (non-fatal)'),
    );
    await recomputeInfluenceScores(tenantId).catch(err =>
      logger.warn({ tenantId, err: (err as Error).message }, 'influence-calculator failed (non-fatal)'),
    );
    const consolidated = await runConsolidationStep(tenantId, agentId, now);
    const graduated = await runGraduationStep(tenantId, agentId, now);
    const roleGraduated = await runRoleGraduationStep(tenantId, now).catch(err => {
      logger.warn({ tenantId, err: (err as Error).message }, 'role-graduation step failed (non-fatal)');
      return 0;
    });
    return { consolidated, graduated: graduated + roleGraduated };
  } finally {
    await pool.query(
      `SELECT pg_advisory_unlock(hashtextextended($1, 0))`,
      [agentId],
    );
  }
}

// --- Consolidation: LLM groups → code selects → LLM rewrites ---

async function runConsolidationStep(
  tenantId: string,
  agentId: string,
  now: Date,
): Promise<number> {
  const pool = getPoolForService('scheduled-execution');

  // Fetch auto-reflection memories (FOR UPDATE SKIP LOCKED to coordinate with pruner)
  const memResult = await pool.query(
    `SELECT id, content, usefulness_score, importance_score, tags, created_at,
            COALESCE(source_trust, 0.5) AS source_trust
     FROM memories
     WHERE tenant_id = $1 AND agent_id = $2
       AND tags @> ARRAY['auto-reflection']
       AND superseded_by IS NULL
       AND (expires_at IS NULL OR expires_at > $3)
       AND content_classification NOT IN ('pii', 'sensitive')
     FOR UPDATE SKIP LOCKED`,
    [tenantId, agentId, now],
  );

  if (memResult.rows.length < MIN_MEMORIES_FOR_CONSOLIDATION) {
    return 0;
  }

  // Step 1: LLM grouping (Haiku — no scores/tags shown, only id + content)
  const memoriesForGrouping = memResult.rows.map(r => ({
    id: r.id as string,
    content: r.content as string,
  }));

  let groups: Array<{ topic: string; memoryIds: string[] }>;
  try {
    groups = await llmGroupMemories(memoriesForGrouping, tenantId, agentId);
  } catch (err) {
    logger.warn({ agentId, err: (err as Error).message }, 'consolidation-loop: LLM grouping failed, skipping');
    return 0;
  }

  // Step 2 + 3: Code selects + LLM rewrites per qualifying group
  let totalConsolidated = 0;
  const memoryMap = new Map(memResult.rows.map(r => [r.id as string, r]));

  for (const group of groups) {
    if (group.memoryIds.length < 2) continue;

    // Cap group size
    const cappedIds = group.memoryIds.slice(0, MAX_GROUP_SIZE);

    // Rank by usefulness, drop negative
    const members = cappedIds
      .map(id => memoryMap.get(id))
      .filter(Boolean)
      .sort((a: any, b: any) => (b.usefulness_score - a.usefulness_score) || (new Date(b.created_at).getTime() - new Date(a.created_at).getTime()))
      .filter((m: any) => m.usefulness_score >= 0);

    if (members.length < 2) continue;

    // LLM prose rewrite
    let consolidatedContent: string;
    try {
      consolidatedContent = await llmRewriteMemories(members.map((m: any) => m.content as string), tenantId, agentId);
    } catch (err) {
      logger.warn({ agentId, topic: group.topic, err: (err as Error).message }, 'consolidation-loop: LLM rewrite failed, skipping group');
      continue;
    }

    // Compute aggregated fields
    const maxUsefulness = Math.max(...members.map((m: any) => m.usefulness_score as number));
    const maxImportance = Math.max(...members.map((m: any) => m.importance_score as number));
    const maxSourceTrust = Math.max(...members.map((m: any) => parseFloat(m.source_trust ?? '0.5')));
    const unionTags = [...new Set(members.flatMap((m: any) => (m.tags || []) as string[]))];
    unionTags.push('consolidated');
    const memberIds = members.map((m: any) => m.id as string);

    // P3: Generate embedding for consolidated memory so it's visible to semantic search
    let embedding: number[] | null = null;
    let embeddingModel: string = getProviderModel(getDefaultProvider());
    try {
      const embedResult = await generateEmbeddingDetailed(consolidatedContent, {
        tenantId,
        agentId,
        purpose: 'embedding_consolidation',
        taskType: 'retrieval_document',
      });
      embedding = embedResult.embedding;
      embeddingModel = embedResult.model;
    } catch (err) {
      logger.warn({ agentId, err: (err as Error).message }, 'consolidation-loop: embedding generation failed, saving without');
    }

    // Step 4: Atomic transaction
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Insert consolidated memory
      // Compute hash in TypeScript to avoid $4 type conflict (text vs bytea) in SQL
      const contentHash = createHash('sha256').update(consolidatedContent).digest('hex');
      const insertResult = await client.query(
        `INSERT INTO memories (tenant_id, agent_id, layer, scope_key, content, content_hash,
          embedding, embedding_model,
          usefulness_score, importance_score, tags, content_classification, expires_at, source_trust)
         VALUES ($1, $2, 'individual', $3, $4, $5,
           $6, $7,
           $8, $9, $10, 'internal', $11, $12)
         RETURNING id`,
        [tenantId, agentId, agentId, consolidatedContent, contentHash,
         embedding ? JSON.stringify(embedding) : null, embeddingModel,
         maxUsefulness, maxImportance, unionTags, new Date(now.getTime() + 90 * 24 * 60 * 60 * 1000), maxSourceTrust],
      );
      const newMemoryId = insertResult.rows[0].id;

      // Supersede members
      await client.query(
        `UPDATE memories SET superseded_by = $1, superseded_at = $2, supersession_reason = 'consolidation'
         WHERE id = ANY($3)`,
        [newMemoryId, now, memberIds],
      );

      // Audit trail
      const beforeContent = members.map((m: any) => m.content).join('\n---\n');
      await client.query(
        `INSERT INTO instruction_amendment_audit (tenant_id, agent_id, amendment_type, source_memory_ids, before_md, after_md)
         VALUES ($1, $2, 'consolidation', $3, $4, $5)`,
        [tenantId, agentId, memberIds, beforeContent, consolidatedContent],
      );

      await provenanceService.recordSynthesis(client, tenantId, memberIds, newMemoryId);

      await client.query('COMMIT');
      totalConsolidated += members.length;
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ agentId, err: (err as Error).message }, 'consolidation-loop: transaction failed');
    } finally {
      client.release();
    }
  }

  if (totalConsolidated > 0) {
    logger.info({ agentId, tenantId, consolidated: totalConsolidated }, 'consolidation-loop: memories consolidated');
  }

  return totalConsolidated;
}

// --- Graduation: validated memories → CLAUDE.md ---

async function runGraduationStep(
  tenantId: string,
  agentId: string,
  now: Date,
): Promise<number> {
  const pool = getPoolForService('scheduled-execution');
  const minAge = new Date(now.getTime() - GRADUATION_MIN_AGE_DAYS * 24 * 60 * 60 * 1000);

  // Individual auto-reflection memories meeting graduation criteria
  const individualResult = await pool.query(
    `SELECT id, content, usefulness_score, importance_score, created_at,
            COALESCE(source_trust, 0.5) AS source_trust
     FROM memories
     WHERE tenant_id = $1 AND agent_id = $2
       AND graduated_at IS NULL
       AND superseded_by IS NULL
       AND usefulness_score >= $3
       AND created_at <= $4
       AND content_classification NOT IN ('pii', 'sensitive')
       AND tags @> ARRAY['auto-reflection']
     ORDER BY usefulness_score DESC
     LIMIT 20`,
    [tenantId, agentId, GRADUATION_MIN_USEFULNESS, minAge],
  );

  // Global memories for cross-agent learning (tenant-scoped)
  const globalResult = await pool.query(
    `SELECT id, content, usefulness_score, importance_score, created_at,
            COALESCE(source_trust, 0.5) AS source_trust
     FROM memories
     WHERE tenant_id = $1
       AND layer = 'global'
       AND tags @> ARRAY['auto-promoted']
       AND graduated_at IS NULL
       AND superseded_by IS NULL
       AND content_classification NOT IN ('pii', 'sensitive')
     ORDER BY usefulness_score DESC
     LIMIT 10`,
    [tenantId],
  );

  const allMemories = [...individualResult.rows, ...globalResult.rows];
  if (allMemories.length === 0) return 0;

  // LLM synthesis: ## Learned pitfalls
  const memoryPromptLines = allMemories.map(m =>
    `[usefulness: ${m.usefulness_score}, age: ${Math.floor((now.getTime() - new Date(m.created_at).getTime()) / 86_400_000)}d] ${m.content}`
  );

  let learnedPitfalls: string;
  try {
    const taskConfig = await getEntitlementsClient().getModelForTask(tenantId, 'memory_consolidation');
    const response = await llmClient.complete(
      {
        messages: [
          {
            role: 'system',
            content: `You are synthesizing operational lessons an AI agent validated through its own experience. Each memory below was retrieved during execution and contributed to successful outcomes (usefulness_score shown in brackets). Convert them into a "## Learned pitfalls" section.

Rules:
- Max ${MAX_CLAUDE_MD_BULLETS} bullet points, most useful first
- Each bullet: specific, actionable, second person ("Do not...", "Always...")
- Each bullet MUST be under ${MAX_BULLET_LENGTH} characters
- IMPORTANT: If memories contradict each other, keep the one with higher usefulness score. If equal, keep the more recent.
- Remove exact duplicates`,
          },
          {
            role: 'user',
            content: `Individual memories (agent-specific):\n${memoryPromptLines.slice(0, 20).join('\n')}\n\nGlobal memories (cross-agent):\n${memoryPromptLines.slice(20).join('\n') || '(none)'}`,
          },
        ],
        maxTokens: 2048,
        temperature: 0.2,
      },
      llmClient.modelSelectionFor(taskConfig),
      { tenantId, agentId, purpose: 'memory_consolidation' },
    );

    learnedPitfalls = response.content;
  } catch (err) {
    logger.warn({ agentId, err: (err as Error).message }, 'consolidation-loop: CLAUDE.md synthesis failed');
    return 0;
  }

  // Output validation (SE-002 fix)
  const validated = validateLearnedPitfalls(learnedPitfalls);
  if (!validated) {
    logger.warn({ agentId }, 'consolidation-loop: CLAUDE.md synthesis failed output validation');
    return 0;
  }

  // Persist
  const memoryIds = allMemories.map(m => m.id);

  // Get current learned_instructions_md for audit before_md
  const currentResult = await pool.query(
    `SELECT id, learned_instructions_md FROM compiled_instructions
     WHERE agent_id = $1 AND tenant_id = $2 AND status = 'active'
     ORDER BY version DESC LIMIT 1`,
    [agentId, tenantId],
  );
  const currentMd = currentResult.rows[0]?.learned_instructions_md || null;
  const compiledId = currentResult.rows[0]?.id;

  if (!compiledId) {
    logger.warn({ agentId }, 'consolidation-loop: no active compiled_instructions found');
    return 0;
  }

  // Audit + update + graduate in transaction
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const auditResult = await client.query(
      `INSERT INTO instruction_amendment_audit (tenant_id, agent_id, amendment_type, source_memory_ids, before_md, after_md)
       VALUES ($1, $2, 'slow_loop_synthesis', $3, $4, $5)
       RETURNING id`,
      [tenantId, agentId, memoryIds, currentMd, validated],
    );
    const amendmentAuditId: string = auditResult.rows[0].id;

    await client.query(
      `UPDATE compiled_instructions SET learned_instructions_md = $1, last_amendment_audit_id = $2
       WHERE id = $3`,
      [validated, amendmentAuditId, compiledId],
    );

    await client.query(
      `UPDATE memories SET graduated_at = $1 WHERE id = ANY($2)`,
      [now, memoryIds],
    );

    await provenanceService.recordAmendment(client, tenantId, memoryIds, amendmentAuditId);

    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error({ agentId, err: (err as Error).message }, 'consolidation-loop: graduation transaction failed');
    return 0;
  } finally {
    client.release();
  }

  logger.info({ agentId, tenantId, graduated: memoryIds.length }, 'consolidation-loop: memories graduated to CLAUDE.md');
  return memoryIds.length;
}

// --- Change A: Role-layer graduation (tenant-scoped) ---
//
// Role-layer memories have agent_id=NULL and scope_key=roleHint (set by
// harvest at memory-client.ts:126). Group by scope_key (which IS the role).
// Writes per-(tenant, role) `learned_role_instructions` + history,
// plus audit row with agent_id=NULL.

async function runRoleGraduationStep(tenantId: string, now: Date): Promise<number> {
  const pool = getPoolForService('scheduled-execution');
  const minAge = new Date(now.getTime() - GRADUATION_MIN_AGE_DAYS * 24 * 60 * 60 * 1000);

  // Track ungraduated-age before pulling the candidate set so dashboards can
  // surface the SLI even on cycles where 0 memories meet the criteria.
  try {
    const lagResult = await pool.query<{ max_age: number | null }>(
      `SELECT EXTRACT(EPOCH FROM (NOW() - MIN(created_at)))::float AS max_age
       FROM memories
       WHERE tenant_id = $1
         AND layer = 'role'
         AND graduated_at IS NULL
         AND superseded_by IS NULL
         AND usefulness_score >= 5
         AND content_classification NOT IN ('pii', 'sensitive')`,
      [tenantId],
    );
    const lagSeconds = Number(lagResult.rows[0]?.max_age ?? 0);
    // tenantId goes on the log line, never the label set — see metric-labels.ts.
    setGauge('graduation_lag_seconds', lagSeconds, { __name: 'graduation_lag_seconds', layer: 'role' });
    logger.info({ tenantId, layer: 'role', lagSeconds }, 'graduation lag observed');
  } catch (err) {
    logger.warn({ tenantId, err: (err as Error).message }, 'graduation-lag gauge emission failed (non-fatal)');
  }

  const roleResult = await pool.query(
    `SELECT id, content, usefulness_score, importance_score, created_at, scope_key,
            COALESCE(source_trust, 0.5) AS source_trust
     FROM memories
     WHERE tenant_id = $1
       AND layer = 'role'
       AND graduated_at IS NULL
       AND superseded_by IS NULL
       AND usefulness_score >= 5
       AND created_at <= $2
       AND content_classification NOT IN ('pii', 'sensitive')
     ORDER BY usefulness_score DESC
     LIMIT 10`,
    [tenantId, minAge],
  );

  if (roleResult.rows.length === 0) return 0;

  // Group by scope_key (which IS the role name for role-layer memories)
  const roleGroups = new Map<string, typeof roleResult.rows>();
  for (const row of roleResult.rows) {
    const role = row.scope_key as string;
    const list = roleGroups.get(role) ?? [];
    list.push(row);
    roleGroups.set(role, list);
  }

  let totalGraduated = 0;
  for (const [role, rows] of roleGroups) {
    if (rows.length === 0) continue;

    // Synthesize per-role learned content using the same prose-rewrite path as the
    // CLAUDE.md graduation. Keep it small and provenance-attributed.
    let synthesized: string;
    try {
      const taskConfig = await getEntitlementsClient().getModelForTask(tenantId, 'memory_consolidation');
      const response = await llmClient.complete(
        {
          messages: [
            {
              role: 'system',
              content: `You are synthesizing validated operational lessons for agents that play the role "${role}". Produce a short list of bullet points an agent in this role should follow.

Rules:
- Max ${MAX_CLAUDE_MD_BULLETS} bullets, most useful first
- Each bullet: specific, actionable, second person ("Do not...", "Always...")
- Each bullet MUST be under ${MAX_BULLET_LENGTH} characters
- Do NOT add information not present in the inputs`,
            },
            {
              role: 'user',
              content: rows.map((m: any, i: number) => `${i + 1}. [usefulness: ${m.usefulness_score}] ${m.content}`).join('\n'),
            },
          ],
          maxTokens: 2048,
          temperature: 0.2,
        },
        llmClient.modelSelectionFor(taskConfig),
        { tenantId, purpose: 'memory_consolidation' },
      );
      const { sanitized } = sanitizeMemoryContent(response.content);
      const validated = validateLearnedPitfalls(sanitized);
      if (!validated) {
        logger.warn({ tenantId, role }, 'role-graduation: output validation failed');
        continue;
      }
      synthesized = validated;
    } catch (err) {
      logger.warn({ tenantId, role, err: (err as Error).message }, 'role-graduation: synthesis failed');
      continue;
    }

    const memoryIds = rows.map((r: any) => r.id as string);

    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const auditResult = await client.query(
        `INSERT INTO instruction_amendment_audit
           (tenant_id, agent_id, amendment_type, source_memory_ids, before_md, after_md)
         VALUES ($1, NULL, 'role_graduation', $2, NULL, $3)
         RETURNING id`,
        [tenantId, memoryIds, synthesized],
      );
      const auditId = auditResult.rows[0].id as string;

      await client.query(
        `INSERT INTO learned_role_instructions
           (tenant_id, role, content_md, source_memory_ids, last_amendment_audit_id, updated_at)
         VALUES ($1, $2, $3, $4, $5, NOW())
         ON CONFLICT (tenant_id, role) DO UPDATE SET
           content_md = EXCLUDED.content_md,
           source_memory_ids = EXCLUDED.source_memory_ids,
           last_amendment_audit_id = EXCLUDED.last_amendment_audit_id,
           updated_at = NOW()`,
        [tenantId, role, synthesized, memoryIds, auditId],
      );

      await client.query(
        `INSERT INTO learned_role_instructions_history
           (tenant_id, role, content_md, source_memory_ids, amendment_audit_id)
         VALUES ($1, $2, $3, $4, $5)`,
        [tenantId, role, synthesized, memoryIds, auditId],
      );

      await client.query(
        `UPDATE memories SET graduated_at = $1 WHERE id = ANY($2)`,
        [now, memoryIds],
      );
      await client.query('COMMIT');
      totalGraduated += memoryIds.length;
      logger.info({ tenantId, role, count: memoryIds.length }, 'role-graduation: memories graduated');
    } catch (err) {
      await client.query('ROLLBACK');
      logger.error({ tenantId, role, err: (err as Error).message }, 'role-graduation transaction failed');
    } finally {
      client.release();
    }
  }

  return totalGraduated;
}

// --- LLM helpers ---

async function llmGroupMemories(
  memories: Array<{ id: string; content: string }>,
  tenantId: string,
  agentId: string,
): Promise<Array<{ topic: string; memoryIds: string[] }>> {
  const memoryText = memories.map(m => `${m.id}: ${m.content}`).join('\n');
  const inputIds = new Set(memories.map(m => m.id));

  const taskConfig = await getEntitlementsClient().getModelForTask(tenantId, 'memory_consolidation');
  const response = await llmClient.complete(
    {
      messages: [
        {
          role: 'system',
          content: `You are reviewing an AI agent's operational memory store. Group related memories by topic — memories about the same tool, connector, error pattern, or workflow step should be in the same group. Return ONLY the grouping as JSON.

RULES:
- Each memory must appear in exactly one group
- A group can have 1 member (unique topic) — that's fine
- Do NOT evaluate quality or decide what to discard
- Group by TOPIC SIMILARITY, not by tags`,
        },
        {
          role: 'user',
          content: `Memories (id: content):\n${memoryText}\n\nReturn: { "groups": [ { "topic": "short label", "memoryIds": ["id1", "id2"] } ] }`,
        },
      ],
      maxTokens: 2048,
      temperature: 0,
    },
    llmClient.modelSelectionFor(taskConfig),
    { tenantId, agentId, purpose: 'memory_consolidation' },
  );

  // Parse and validate
  const parsed = JSON.parse(response.content);
  const groups: Array<{ topic: string; memoryIds: string[] }> = parsed.groups;

  // Validate: all input IDs accounted for, no invented IDs
  const outputIds = new Set(groups.flatMap(g => g.memoryIds));
  for (const id of outputIds) {
    if (!inputIds.has(id)) {
      throw new Error(`LLM grouping invented unknown memory ID: ${id}`);
    }
  }
  // Allow missing IDs (LLM may drop some) — they stay ungrouped
  // Cap group sizes
  for (const group of groups) {
    if (group.memoryIds.length > MAX_GROUP_SIZE) {
      group.memoryIds = group.memoryIds.slice(0, MAX_GROUP_SIZE);
    }
  }

  return groups;
}

async function llmRewriteMemories(contents: string[], tenantId: string, agentId: string): Promise<string> {
  const taskConfig = await getEntitlementsClient().getModelForTask(tenantId, 'memory_consolidation');
  const response = await llmClient.complete(
    {
      messages: [
        {
          role: 'system',
          content: `Rewrite these related operational memories into a single coherent entry.
RULES:
- Do NOT add any information not present in the inputs
- Do NOT discard any specific details (numbers, identifiers, thresholds)
- Combine into 1-3 sentences maximum
- Write in second person ("Do not...", "Always...")`,
        },
        {
          role: 'user',
          content: contents.map((c, i) => `${i + 1}. ${c}`).join('\n'),
        },
      ],
      maxTokens: 512,
      temperature: 0.1,
    },
    llmClient.modelSelectionFor(taskConfig),
    { tenantId, agentId, purpose: 'memory_consolidation' },
  );

  // P4: Sanitize LLM rewrite output before persisting
  const raw = response.content.trim();
  const { sanitized } = sanitizeMemoryContent(raw);
  return sanitized;
}

// --- Output validation ---

function validateLearnedPitfalls(content: string): string | null {
  // Must contain the section header
  if (!content.includes('## Learned pitfalls') && !content.includes('## Learned Pitfalls')) {
    // Try to prepend the header if it's just bullet points
    if (content.startsWith('-') || content.startsWith('*')) {
      content = `## Learned pitfalls\n\n${content}`;
    } else {
      return null;
    }
  }

  // Extract bullets
  const lines = content.split('\n').filter(l => l.trim().startsWith('-') || l.trim().startsWith('*'));

  // Cap at max bullets
  const cappedLines = lines.slice(0, MAX_CLAUDE_MD_BULLETS);

  // Validate each bullet length
  const validBullets = cappedLines.filter(l => l.trim().length <= MAX_BULLET_LENGTH);
  if (validBullets.length === 0) return null;

  // Check for instruction-override patterns (SE-002)
  const INJECTION_CHECK = /ignore\s+(all\s+|previous\s+)?(instructions|prompts)|you\s+are\s+now|system\s*:/i;
  const safeBullets = validBullets.filter(l => !INJECTION_CHECK.test(l));
  if (safeBullets.length === 0) return null;

  return `## Learned pitfalls\n\n${safeBullets.join('\n')}`;
}
