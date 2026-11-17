// Superseded-skill retention.
//
// Superseding is an UPDATE, so a rewrite leaves the previous row in the table.
// Where the control plane sends a stable id the runtime reactivates that row in
// place and nothing accumulates; where it does not, every publish inserts under
// a fresh id and the old rows stay forever. Nothing reads a superseded row and
// no foreign key references agent_skills, so the tail is safe to drop.
//
// Two operational constraints shape this:
//
//   * Deleting in one statement would put the whole tail in a single WAL record.
//     The loop bounds each transaction to RETENTION_BATCH_SIZE rows.
//   * The embedding index is HNSW, which keeps tombstones for deleted rows. A
//     VACUUM alone will not return the space, so the caller reindexes once the
//     delete has drained.

import { getPoolForService } from '../infrastructure/database';
import { logger } from '../infrastructure/logging';

/** Superseded rows kept per (agent_id, name), newest first. */
export const RETENTION_KEEP_PER_SKILL = 3;

/** Rows per DELETE statement. */
export const RETENTION_BATCH_SIZE = 5000;

/** Bounds a single job run so one invocation cannot hold the pool all day. */
const MAX_BATCHES_PER_RUN = 200;

export interface SkillRetentionResult {
  deleted: number;
  batches: number;
  drained: boolean;
  reindexed: boolean;
  /** Why the reindex did not happen, when it did not. */
  reindexError?: string;
}

export async function runAgentSkillsRetention(): Promise<SkillRetentionResult> {
  const pool = getPoolForService('scheduled-execution');

  let deleted = 0;
  let batches = 0;
  let drained = false;

  for (; batches < MAX_BATCHES_PER_RUN; batches++) {
    const result = await pool.query(
      `DELETE FROM agent_skills WHERE id IN (
         SELECT id FROM (
           SELECT id, row_number() OVER (
                    PARTITION BY agent_id, name ORDER BY updated_at DESC
                  ) AS rn
             FROM agent_skills
            WHERE status = 'superseded'
         ) ranked
         WHERE rn > $1
         LIMIT $2
       )`,
      [RETENTION_KEEP_PER_SKILL, RETENTION_BATCH_SIZE],
    );

    const rows = result.rowCount ?? 0;
    deleted += rows;
    if (rows === 0) {
      drained = true;
      batches += 1;
      break;
    }
  }

  // Only worth the rebuild when rows actually went away, and only once the tail
  // has drained — reindexing between batches would just be redone next pass.
  //
  // The deletes are already committed by this point, so a reindex failure must
  // not present as a failed sweep: it needs index ownership, which is a grant
  // this job does not control. Report it and let the caller decide; the next run
  // retries, and until then the index simply keeps its tombstones.
  let reindexed = false;
  let reindexError: string | undefined;
  if (deleted > 0 && drained) {
    try {
      await pool.query('REINDEX INDEX CONCURRENTLY idx_agent_skills_hnsw');
      reindexed = true;
    } catch (err) {
      reindexError = (err as Error).message;
      logger.error(
        { deleted, error: reindexError },
        'agent-skills-retention: rows deleted but the HNSW index could not be rebuilt',
      );
    }
  }

  logger.info({ deleted, batches, drained, reindexed }, 'agent-skills-retention: swept superseded skills');

  return { deleted, batches, drained, reindexed, ...(reindexError ? { reindexError } : {}) };
}
