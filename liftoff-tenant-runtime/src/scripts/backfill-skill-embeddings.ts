// One-shot operator script — backfills embeddings for agent_skills rows
// whose embedding column is NULL.
//
// Originally needed because tenant-runtime's agent_skills.embedding column
// was added after some rows already existed AND the write-time path
// silently stored NULL on transient embedding-generation failures. The
// instruction-compiler now retries 3× and ERROR-logs on persistent failure,
// and the cron handler runs the same sweep every 15 minutes. This script
// closes the gap for the existing NULL backlog on first deploy.
//
// Run via a one-off Cloud Run Job using the tenant-runtime image at the SHA
// that contains this script. The Job entrypoint:
//   node dist/scripts/backfill-skill-embeddings.js
//
// The script loops until the sweeper reports done=true. Each pass processes
// 50 rows. With Liftoff OS sitting at 178 NULL rows that's ~4 passes; with a
// hypothetical larger tenant it just takes longer.
//
// Idempotent — already-embedded rows are filtered out by the SELECT and the
// UPDATE guards on `embedding IS NULL`. Safe to re-run.

import { sweepNullSkillEmbeddings } from '../skills/embedding-sweeper';
import { logger } from '../infrastructure/logging';

const PASS_LIMIT = 50;
const MAX_PASSES = 200;  // hard cap; protects against a stuck loop

export async function runBackfill(): Promise<void> {
  let totalAttempted = 0;
  let totalSucceeded = 0;
  let totalFailed = 0;

  for (let pass = 1; pass <= MAX_PASSES; pass++) {
    const result = await sweepNullSkillEmbeddings(PASS_LIMIT);
    totalAttempted += result.attempted;
    totalSucceeded += result.succeeded;
    totalFailed += result.failed;

    logger.info(
      { pass, ...result, totals: { attempted: totalAttempted, succeeded: totalSucceeded, failed: totalFailed } },
      'backfill-skill-embeddings: pass complete',
    );

    // Check the all-fail bail BEFORE the done check. A small NULL set that
    // fits in one pass would otherwise look "done" because rows < limit,
    // even when every embed call failed — silently masking a persistent
    // issue (auth, quota, dimension mismatch, provider outage).
    if (result.attempted > 0 && result.succeeded === 0) {
      logger.error(
        { pass, ...result },
        'backfill-skill-embeddings: every row in pass failed; aborting (re-run after diagnosing)',
      );
      process.exit(1);
    }

    if (result.done) {
      logger.info(
        { totals: { attempted: totalAttempted, succeeded: totalSucceeded, failed: totalFailed }, passes: pass },
        'backfill-skill-embeddings: no more NULL rows — exiting',
      );
      return;
    }
  }

  logger.warn(
    { totals: { attempted: totalAttempted, succeeded: totalSucceeded, failed: totalFailed }, passes: MAX_PASSES },
    'backfill-skill-embeddings: hit MAX_PASSES cap — re-run to finish',
  );
}

if (require.main === module) {
  runBackfill().then(() => process.exit(0)).catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}
