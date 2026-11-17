// Memory Pruner
// Phase 8.5E: Reviews auto-generated memories during scheduled reflections.
// Checks if error patterns still occur in recent audit logs.
// Supersedes stale memories that describe resolved errors.

import { memoryService } from '../memory/service';
import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

const RECENCY_WINDOW_DAYS = 14;

/**
 * Prune stale auto-generated memories for an agent.
 * Called by the reflection engine during scheduled reflections.
 *
 * For each individual memory tagged 'auto-extracted' with 'error-pattern':
 * - Check if the error pattern has recurred in the last 14 days
 * - If not, supersede the memory with reason 'error_resolved'
 */
export async function pruneStaleMemories(
  tenantId: string,
  agentId: string
): Promise<number> {
  const pool = getPoolForService('reflection-engine');
  let pruned = 0;

  // Find auto-extracted error pattern memories for this agent
  const memResult = await pool.query(
    `SELECT id, content, scope_key, tags
     FROM memories
     WHERE tenant_id = $1 AND agent_id = $2
       AND layer = 'individual'
       AND superseded_by IS NULL
       AND (expires_at IS NULL OR expires_at > NOW())
       AND tags @> ARRAY['auto-extracted', 'error-pattern']::text[]
     LIMIT 50`,
    [tenantId, agentId]
  );

  for (const memory of memResult.rows) {
    try {
      // Extract tool name from tags (the third tag is the tool name)
      const toolName = memory.tags?.find(
        (t: string) => t !== 'auto-extracted' && t !== 'error-pattern'
      );

      if (!toolName) continue;

      // Check if this error pattern has recurred recently
      const recentErrors = await pool.query(
        `SELECT COUNT(*) as count
         FROM audit_logs
         WHERE tenant_id = $1 AND internal_agent_id = $2
           AND action = $3
           AND outcome = 'error'
           AND created_at >= NOW() - INTERVAL '1 day' * $4`,
        [tenantId, agentId, toolName, RECENCY_WINDOW_DAYS]
      );

      const errorCount = parseInt(recentErrors.rows[0]?.count) || 0;

      if (errorCount === 0) {
        // Error hasn't recurred — supersede the memory
        await memoryService.supersedeMemory({
          memoryId: memory.id,
          newContent: `[RESOLVED] ${memory.content}. This error has not recurred in ${RECENCY_WINDOW_DAYS} days.`,
          reason: 'error_resolved',
        }, tenantId);

        pruned++;
        logger.info({
          tenantId, agentId,
          memoryId: memory.id,
          toolName,
        }, 'Stale error memory superseded');
      }
    } catch (err) {
      logger.warn({ err, memoryId: memory.id }, 'Non-fatal: memory pruning failed for individual memory');
    }
  }

  if (pruned > 0) {
    logger.info({ tenantId, agentId, pruned }, 'Memory pruning completed');
  }

  return pruned;
}
