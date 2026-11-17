// Backfill pinned knowledge — Cloud Run Job entry point.
//
// One-shot job that walks every internal_agent, parses [[knowledge:...]]
// markers from responsibilities + additional_context, validates each pin's
// connector against the agent's bound integrations, populates the new
// pinned_knowledge_ids column, and strips the legacy ## Knowledge section
// from system_prompt when it exactly matches the auto-generated shape.
//
// Idempotent. Designed to be run once at deploy:
//   gcloud run jobs execute backfill-pinned-knowledge-{env} \
//     --project=YOUR_GCP_PROJECT --region=us-west1 --wait
//
// Usage (Cloud Run Job):
//   command: node
//   args:    dist/scripts/backfill-pinned-knowledge.js
// Exits 0 on success, 1 on failure.

import { initSecrets } from '../infrastructure/secrets';
import { initDatabase, closePools } from '../infrastructure/database';
import { runBackfillBatch } from '../jobs/backfill-pinned-knowledge';
import { log } from '../infrastructure/logging';

async function main(): Promise<void> {
  log.info({ event: 'backfill_pinned_knowledge_start' }, 'Backfill job starting');
  await initSecrets();
  await initDatabase();
  try {
    const totals = await runBackfillBatch();
    log.info({ event: 'backfill_pinned_knowledge_complete', totals }, 'Backfill job complete');
  } finally {
    await closePools();
  }
}

main().then(
  () => process.exit(0),
  (err) => {
    log.error({ err: (err as Error).message, stack: (err as Error).stack }, 'Backfill job failed');
    process.exit(1);
  },
);
