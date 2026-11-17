// Knowledge Promoter
// Scans individual memories and promotes recurring patterns to global layer.
// If 3+ agents share similar individual memories, promote to broader scope.
//
// REVIEW FIX DE-008: Uses batch nearest-neighbor queries via HNSW index
// instead of expensive cross-join. O(n * k) instead of O(n^2).

import { memoryService } from '../memory/service';
import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import * as provenanceService from '../memory/provenance-service';

const MIN_AGENTS_FOR_PROMOTION = 3;
const SIMILARITY_THRESHOLD = 0.85;
const MAX_MEMORIES_PER_RUN = 20;
const DAILY_GLOBAL_PROMOTION_CAP = 5;

export async function promoteSharedKnowledge(tenantId: string): Promise<number> {
  const pool = getPoolForService('reflection-engine');
  let promoted = 0;

  // Rate limit: max 5 global promotions per tenant per 24h
  // "Global" means tenant-scoped global — never cross-tenant.
  const recentPromotions = await pool.query(
    `SELECT COUNT(*) as cnt FROM memories
     WHERE tenant_id = $1 AND layer = 'global' AND tags @> ARRAY['auto-promoted']
       AND created_at > NOW() - INTERVAL '24 hours'`,
    [tenantId],
  );
  const remainingBudget = DAILY_GLOBAL_PROMOTION_CAP - parseInt(recentPromotions.rows[0].cnt, 10);
  if (remainingBudget <= 0) {
    logger.info({ tenantId, cap: DAILY_GLOBAL_PROMOTION_CAP }, 'Knowledge promoter: daily cap reached');
    return 0;
  }

  // REVIEW FIX DE-008: Use batch nearest-neighbor via HNSW index instead of cross-join.
  // For each individual memory, find its K nearest neighbors across other agents.
  // P5: Exclude PII/sensitive memories to prevent ciphertext leak on promotion
  const individualMemories = await pool.query(
    `SELECT id, content, scope_key, agent_id, tags, embedding
     FROM memories
     WHERE tenant_id = $1 AND layer = 'individual'
       AND superseded_by IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())
       AND content_classification NOT IN ('pii', 'sensitive')
       AND embedding IS NOT NULL
     ORDER BY created_at DESC
     LIMIT $2`,
    [tenantId, MAX_MEMORIES_PER_RUN]
  );

  for (const memory of individualMemories.rows) {
    try {
      // Find similar memories from OTHER agents using the HNSW index
      const similarResult = await pool.query(
        `SELECT id, agent_id
         FROM memories
         WHERE tenant_id = $1
           AND layer = 'individual'
           AND agent_id != $2
           AND superseded_by IS NULL
           AND (expires_at IS NULL OR expires_at > NOW())
           AND embedding IS NOT NULL
           AND (embedding <=> $3::vector) < $4
         LIMIT 10`,
        [tenantId, memory.agent_id, memory.embedding, 1 - SIMILARITY_THRESHOLD]
      );

      const distinctAgents = new Set(similarResult.rows.map((r: { agent_id: string }) => r.agent_id)).size;
      const corroboratingMemoryIds: string[] = similarResult.rows.map((r: { id: string }) => r.id);

      // Need MIN_AGENTS_FOR_PROMOTION - 1 OTHER agents (plus the original = total of MIN)
      if (distinctAgents < MIN_AGENTS_FOR_PROMOTION - 1) continue;

      // Check if already promoted
      const existing = await memoryService.retrieveMemories({
        tenantId,
        query: memory.content,
        layers: ['global'],
        topK: 1,
        minSimilarity: SIMILARITY_THRESHOLD,
      });

      if (existing.length > 0) continue;

      // Promote to global layer within a transaction, recording synthesis provenance
      const client = await pool.connect();
      try {
        await client.query('BEGIN');

        const { memoryId: promotedMemoryId } = await memoryService.saveMemory({
          tenantId,
          layer: 'global',
          scopeKey: `promoted-${memory.scope_key}`,
          content: memory.content,
          tags: [...(memory.tags || []), 'auto-promoted'],
          contentClassification: 'internal',
          tx: client,
          source: {
            nodeType: 'memory' as const,           // lineage from existing memory
            refId: memory.id,
            agentId: memory.agent_id ?? undefined,
            metadata: {
              promotionReason: 'cross-agent-corroboration',
              corroboratingMemoryIds,
            },
          },
        });

        await provenanceService.recordSynthesis(
          client,
          tenantId,
          [memory.id, ...corroboratingMemoryIds],
          promotedMemoryId,
        );
        await client.query(
          `UPDATE memories SET graduated_at = NOW() WHERE id = $1 AND tenant_id = $2`,
          [memory.id, tenantId],
        );

        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK');
        throw e;
      } finally {
        client.release();
      }

      promoted++;
      logger.info({
        tenantId,
        scopeKey: memory.scope_key,
        agentCount: distinctAgents + 1,
      }, 'Knowledge promoted to global');

      // Respect daily cap
      if (promoted >= remainingBudget) {
        logger.info({ tenantId, promoted, cap: DAILY_GLOBAL_PROMOTION_CAP }, 'Knowledge promoter: budget exhausted for this run');
        break;
      }
    } catch (err) {
      logger.warn({ err, memoryId: memory.id }, 'Non-fatal: knowledge promotion failed');
    }
  }

  // High-usage single-agent promotion path.
  // A memory that has been observed many times by ONE agent is also a promotion
  // candidate, distinct from the cross-agent corroboration path above.
  const HIGH_USAGE_THRESHOLD = 10;
  const remainingBudgetAfterCrossAgent = remainingBudget - promoted;
  if (remainingBudgetAfterCrossAgent > 0) {
    const highUsage = await pool.query(
      `SELECT id, content, scope_key, agent_id, tags, usage_count
       FROM memories
       WHERE tenant_id = $1
         AND layer = 'individual'
         AND usage_count >= $2
         AND superseded_by IS NULL
         AND (expires_at IS NULL OR expires_at > NOW())
         AND content_classification NOT IN ('pii', 'sensitive')
         AND embedding IS NOT NULL
         AND graduated_at IS NULL
       ORDER BY usage_count DESC, updated_at DESC
       LIMIT $3`,
      [tenantId, HIGH_USAGE_THRESHOLD, remainingBudgetAfterCrossAgent],
    );

    for (const memory of highUsage.rows) {
      try {
        // Check if already promoted via content similarity (catches near-duplicates).
        // The definitive marker is `graduated_at` on the source memory itself —
        // both promotion paths must set it now (see below).
        const existingByContent = await memoryService.retrieveMemories({
          tenantId,
          query: memory.content,
          layers: ['global'],
          topK: 1,
          minSimilarity: SIMILARITY_THRESHOLD,
        });
        if (existingByContent.length > 0) continue;

        const client = await pool.connect();
        try {
          await client.query('BEGIN');

          const { memoryId: promotedMemoryId } = await memoryService.saveMemory({
            tenantId,
            layer: 'global',
            scopeKey: `promoted-usage-${memory.scope_key}`,
            content: memory.content,
            tags: [...(memory.tags || []), 'auto-promoted', 'high-usage'],
            contentClassification: 'internal',
            tx: client,
            source: {
              nodeType: 'memory' as const,
              refId: memory.id,
              agentId: memory.agent_id ?? undefined,
              metadata: {
                promotionReason: 'high-usage-single-agent',
                usageCount: memory.usage_count,
              },
            },
          });

          await provenanceService.recordSynthesis(client, tenantId, [memory.id], promotedMemoryId);
          await client.query(
            `UPDATE memories SET graduated_at = NOW() WHERE id = $1 AND tenant_id = $2`,
            [memory.id, tenantId],
          );
          await client.query('COMMIT');
        } catch (e) {
          await client.query('ROLLBACK');
          throw e;
        } finally {
          client.release();
        }

        promoted++;
        logger.info({
          tenantId,
          scopeKey: memory.scope_key,
          usageCount: memory.usage_count,
        }, 'Knowledge promoted to global (high-usage path)');

        if (promoted >= remainingBudget) break;
      } catch (err) {
        logger.warn({ err, memoryId: memory.id }, 'Non-fatal: high-usage promotion failed');
      }
    }
  }

  return promoted;
}
