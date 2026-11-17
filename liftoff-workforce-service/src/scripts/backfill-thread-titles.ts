// One-shot backfill: give the already-written CAIO plan threads the titles the
// broken generator never produced.
//
// The CAIO's fork of the thread-title generator asked the model for prose and
// parsed it; on a real exchange the model fences its JSON, the parse threw, and
// the thread stayed untitled. Deleting the fork fixes new threads only — on
// prod, 21 of the 24 threads the history modal actually shows still read
// "Untitled Chat". This is the pass over those rows.
//
// It is deliberately not a repair of its own. It calls the same
// maybeGenerateThreadTitle a live turn calls, with the same first-user-message
// and first-assistant-reply inputs, so a title written here is indistinguishable
// from one written at the time. Nothing about titling lives in this file.
//
// Safety properties worth stating, because a sweep that writes to every tenant
// should have them written down:
//   - Candidates come from a SECURITY DEFINER function (migration 017), the
//     sanctioned cross-tenant read. Every per-thread read and the write itself
//     run inside withTenantContext.
//   - Threads renamed by hand are excluded twice: by the candidate query and by
//     updateThreadTitleInternal's `title_source IS DISTINCT FROM 'user'`.
//   - Re-running is safe. A thread that got a title stops being a candidate; a
//     thread whose model call failed is simply picked up next time.
//   - One thread's failure does not stop the sweep.
//
// Run as a Cloud Run Job against the workforce-service image:
//   node dist/scripts/backfill-thread-titles.js
// Env: DRY_RUN=1 to list candidates without calling a model (default off),
//      BACKFILL_LIMIT to cap the sweep (default 500).

import { getPool, initPool } from '../infrastructure/database.js';
import { withTenantContext } from '../infrastructure/rls.js';
import { log } from '../infrastructure/logging.js';
import { updateThreadTitleInternal } from '../workforce-plans/chat-repository.js';
import { maybeGenerateThreadTitle } from '../workforce-plans/thread-title.js';

interface Candidate {
  threadId: string;
  tenantId: string;
}

interface FirstExchange {
  userMessage: string;
  assistantMessage: string;
}

/** The sanctioned cross-tenant read. See migrations/017. */
async function findCandidates(limit: number): Promise<Candidate[]> {
  const result = await getPool().query<{ thread_id: string; tenant_id: string }>(
    'SELECT thread_id, tenant_id FROM workforce_find_untitled_plan_threads($1)',
    [limit],
  );
  return result.rows.map(r => ({ threadId: r.thread_id, tenantId: r.tenant_id }));
}

/**
 * The first user message and the first assistant reply that follows it — the
 * same two inputs a live turn feeds the generator on turn one.
 */
async function loadFirstExchange(c: Candidate): Promise<FirstExchange | null> {
  return withTenantContext(c.tenantId, async (client) => {
    const { rows } = await client.query<{ role: string; content: string }>(
      `SELECT role, content
       FROM team_plan_messages
       WHERE thread_id = $1
       ORDER BY created_at ASC, id ASC`,
      [c.threadId],
    );

    const userIndex = rows.findIndex(r => r.role === 'user' && r.content.trim().length > 0);
    if (userIndex === -1) return null;

    const reply = rows.slice(userIndex + 1).find(r => r.role === 'assistant' && r.content.trim().length > 0);
    if (!reply) return null;

    return { userMessage: rows[userIndex]!.content, assistantMessage: reply.content };
  });
}

export async function backfillThreadTitles(options: {
  limit: number;
  dryRun: boolean;
}): Promise<{ candidates: number; titled: number; skipped: number; failed: number }> {
  const candidates = await findCandidates(options.limit);
  log.info(
    { candidates: candidates.length, dryRun: options.dryRun },
    'CAIO title backfill: candidates found',
  );

  let titled = 0;
  let skipped = 0;
  let failed = 0;

  for (const candidate of candidates) {
    try {
      const exchange = await loadFirstExchange(candidate);
      if (!exchange) {
        // A user message with no assistant reply after it — a turn that failed
        // at the time. There is nothing to summarize into a title.
        skipped += 1;
        continue;
      }

      if (options.dryRun) {
        log.info(
          { threadId: candidate.threadId, preview: exchange.userMessage.slice(0, 80) },
          'CAIO title backfill: would title',
        );
        titled += 1;
        continue;
      }

      await maybeGenerateThreadTitle({
        threadId: candidate.threadId,
        tenantId: candidate.tenantId,
        userMessage: exchange.userMessage,
        assistantMessage: exchange.assistantMessage,
        purpose: 'caio_workforce_planning_title_generation',
        updateTitle: updateThreadTitleInternal,
      });
      titled += 1;
    } catch (err) {
      // The shared generator swallows its own failures, so reaching here means
      // something structural. Keep going; the thread stays a candidate.
      failed += 1;
      log.warn(
        { threadId: candidate.threadId, error: (err as Error).message },
        'CAIO title backfill: thread failed',
      );
    }
  }

  return { candidates: candidates.length, titled, skipped, failed };
}

async function main(): Promise<void> {
  const limit = Number(process.env['BACKFILL_LIMIT'] ?? 500);
  const dryRun = process.env['DRY_RUN'] === '1';

  // A job process boots none of the server's startup path, so the pool that
  // every query here reaches for does not exist until this runs.
  await initPool();

  const summary = await backfillThreadTitles({ limit, dryRun });

  log.info(summary, 'CAIO title backfill: done');
  // Also on stdout, so a Cloud Run Job execution log shows the result without
  // needing the structured-log viewer.
  console.log(
    `BACKFILL-DONE candidates=${summary.candidates} titled=${summary.titled} ` +
      `skipped=${summary.skipped} failed=${summary.failed} dryRun=${dryRun}`,
  );

  await getPool().end();
}

// Only when run as the job's entry point, so the tests can import the sweep
// without it opening a pool and calling a model on import.
if (process.argv[1]?.includes('backfill-thread-titles')) {
  main().catch((err) => {
    log.error({ error: (err as Error).message }, 'CAIO title backfill: fatal');
    console.error('BACKFILL-FATAL', (err as Error).message);
    process.exit(1);
  });
}
