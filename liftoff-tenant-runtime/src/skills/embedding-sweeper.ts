// Sweeper for agent_skills rows whose embedding is NULL.
//
// Self-heals two failure modes:
//   1. Write-time embedding generation failed (the instruction-compiler
//      retries 3x with backoff; persistent failures fall through and INSERT
//      with NULL. The sweeper picks those up.)
//   2. The embedding column was added to agent_skills after some rows already
//      existed. Backfill catches those up.
//
// Shared by:
//   - The periodic cron route /api/internal/skill-embedding-sweeper (limit=100)
//   - The one-shot scripts/backfill-skill-embeddings.ts (limit=Infinity, looped)
//
// Always uses generateEmbedding (which honors tenant entitlements + the
// embedding_cache) so behavior matches the write-time path.

import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';
import { generateEmbeddingDetailed } from '../memory/embedding';

export interface SweepResult {
  attempted: number;
  succeeded: number;
  failed: number;
  done: boolean;  // true when no more NULL-embedding rows exist
}

interface SkillRow {
  id: string;
  tenant_id: string;
  agent_id: string;
  name: string;
  description: string;
}

/**
 * Picks up to `limit` active agent_skills rows with NULL embedding,
 * regenerates each row's embedding, and updates the row. Per-row failures are
 * logged and counted; the function does not throw on individual failures so a
 * single bad row doesn't block recovery of the rest of the batch.
 *
 * Returns done=true if the SELECT returned fewer than `limit` rows — caller
 * can use this to decide whether to loop again (backfill) or wait for the
 * next cron tick (sweeper).
 */
export async function sweepNullSkillEmbeddings(limit: number): Promise<SweepResult> {
  const pool = getPoolForService('scheduled-execution');

  const { rows } = await pool.query<SkillRow>(
    `SELECT id, tenant_id, agent_id, name, description
       FROM agent_skills
      WHERE status = 'active' AND embedding IS NULL
      ORDER BY created_at ASC
      LIMIT $1`,
    [limit],
  );

  let succeeded = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const res = await generateEmbeddingDetailed(row.description, {
        tenantId: row.tenant_id,
        agentId: row.agent_id,
        purpose: 'embedding_skill_backfill',
        taskType: 'retrieval_document',
      });
      // Explicit ::vector cast on $1 — without it, PG fails the first
      // parse with "inconsistent types deduced for parameter $1" because
      // the string '[0.1,0.2,...]' can't be unambiguously deduced into
      // the halfvec column. Same fix applied at INSERT sites in
      // instruction-compiler/internal-agent-instruction-service.ts.
      // Column is halfvec(3072) after migration 259.
      await pool.query(
        `UPDATE agent_skills
            SET embedding = $1::vector, embedding_model = $2, updated_at = NOW()
          WHERE id = $3::uuid AND embedding IS NULL`,
        [`[${res.embedding.join(',')}]`, res.model, row.id],
      );
      succeeded += 1;
    } catch (err) {
      failed += 1;
      logger.error(
        {
          err: (err as Error).message,
          skillId: row.id,
          agentId: row.agent_id,
          tenantId: row.tenant_id,
          skillName: row.name,
        },
        'skill-embedding-sweeper: failed to regenerate embedding (will retry on next tick)',
      );
    }
  }

  return {
    attempted: rows.length,
    succeeded,
    failed,
    done: rows.length < limit,
  };
}
