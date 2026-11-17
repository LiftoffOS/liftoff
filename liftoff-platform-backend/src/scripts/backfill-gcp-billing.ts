// Catch the GCP billing ingester up over a range of days.
//
// The ingester deliberately processes ONE day per invocation and advances its
// cursor by one, which is the right shape for a daily job and useless for
// history: a six-month gap would take six months of daily runs to close. This
// drives the same function in a loop so the gap closes in one pass.
//
// Safe to re-run over days already ingested. Every row carries a deterministic
// source_id (`<date>_<tenant>_<service>`, `<date>_platform_overhead`), the
// insert is `ON CONFLICT (source, source_id, event_type, occurred_at) DO
// NOTHING`, and `applyOuConsumption` takes an isDuplicate callback keyed on the
// same source_id — so a repeat drains no buckets and fires no Stripe meter. That
// property is what makes a backfill over real billing data safe at all; without
// it a re-run would charge every tenant twice.
//
//   FROM_DATE=YYYY-MM-DD     first day to ingest (required)
//   MAX_DAYS=N               stop after N days (default 400)
//   DRY_RUN=1                report the range and stop, writing nothing
//   ALLOW_CURSOR_ADVANCE=1   permit moving the cursor FORWARD to FROM_DATE,
//                            abandoning the days in between. Off by default:
//                            the cursor only moves forward afterwards, so a
//                            skipped day is never ingested by anything.

import { initSecrets } from '../infrastructure/secrets';
import { initDatabase, closePools } from '../infrastructure/database';
import { runGcpBillingIngester } from '../cost-attribution/ingestion/gcp-billing-ingester';
import { getCursor, updateCursor } from '../cost-attribution/repository';
import { log } from '../infrastructure/logging';

const DEFAULT_MAX_DAYS = 400;

function yesterdayUtc(): string {
  const d = new Date();
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function previousDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

function nextDay(dateStr: string): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function cursorDate(lastTs: Date | null): string | null {
  return lastTs ? lastTs.toISOString().slice(0, 10) : null;
}

export interface BackfillResult {
  daysProcessed: number;
  eventsIngested: number;
  stoppedBecause: 'caught-up' | 'max-days' | 'table-missing' | 'cursor-stalled' | 'dry-run';
}

export async function runGcpBillingBackfill(): Promise<BackfillResult> {
  const fromDate = process.env.FROM_DATE;
  const maxDays  = Number(process.env.MAX_DAYS ?? DEFAULT_MAX_DAYS);
  const dryRun   = process.env.DRY_RUN === '1';

  if (!fromDate || !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) {
    throw new Error('FROM_DATE=YYYY-MM-DD is required');
  }

  const target = yesterdayUtc();
  const existing = cursorDate((await getCursor('gcp_billing')).lastTs);
  log.info({ fromDate, target, existingCursor: existing, maxDays, dryRun },
    'gcp-billing-backfill: starting');

  if (dryRun) return { daysProcessed: 0, eventsIngested: 0, stoppedBecause: 'dry-run' };

  // The ingester derives its next day from the cursor, so moving the cursor is
  // how a range is selected. Set it to the day BEFORE the first day wanted.
  //
  // Rewinding is always safe — re-ingesting a day is a no-op. Advancing is not:
  // it abandons every day between, and the cursor only ever moves forward
  // afterwards, so those days are never revisited. That is the silent gap this
  // script exists to repair, so it requires ALLOW_CURSOR_ADVANCE and says
  // exactly what is being given up.
  const desired = previousDay(fromDate);
  if (!existing || existing >= fromDate) {
    await updateCursor('gcp_billing', new Date(`${desired}T23:59:59Z`));
    log.info({ cursorSetTo: desired }, 'gcp-billing-backfill: cursor rewound');
  } else if (process.env.ALLOW_CURSOR_ADVANCE === '1') {
    log.warn(
      { from: nextDay(existing), to: desired, cursorSetTo: desired },
      'gcp-billing-backfill: SKIPPING a range on purpose — those days will not be ingested by this or any later run',
    );
    await updateCursor('gcp_billing', new Date(`${desired}T23:59:59Z`));
  } else {
    log.info(
      { existing, fromDate },
      'gcp-billing-backfill: cursor is behind FROM_DATE — resuming from the cursor rather than skipping (set ALLOW_CURSOR_ADVANCE=1 to skip)',
    );
  }

  let daysProcessed = 0;
  let eventsIngested = 0;

  for (let i = 0; i < maxDays; i++) {
    const before = cursorDate((await getCursor('gcp_billing')).lastTs);
    if (before && before >= target) {
      log.info({ cursor: before, target }, 'gcp-billing-backfill: caught up');
      return { daysProcessed, eventsIngested, stoppedBecause: 'caught-up' };
    }

    const result = await runGcpBillingIngester();

    if (result.tableMissing) {
      // Nothing downstream can succeed and the cursor will not move. Stop
      // rather than spend the whole budget re-proving it.
      log.error({ daysProcessed }, 'gcp-billing-backfill: billing export table missing — stopping');
      return { daysProcessed, eventsIngested, stoppedBecause: 'table-missing' };
    }

    const after = cursorDate((await getCursor('gcp_billing')).lastTs);
    if (after === before) {
      // The ingester returns {0,0} both when it is up to date and when it
      // declined a day, so a stalled cursor — not a zero count — is the only
      // reliable stop signal. Without this the loop spins to MAX_DAYS.
      log.warn({ cursor: after, target }, 'gcp-billing-backfill: cursor did not advance — stopping');
      return { daysProcessed, eventsIngested, stoppedBecause: 'cursor-stalled' };
    }

    daysProcessed  += 1;
    eventsIngested += result.ingested;
    if (daysProcessed % 10 === 0) {
      log.info({ daysProcessed, eventsIngested, cursor: after }, 'gcp-billing-backfill: progress');
    }
  }

  log.warn({ daysProcessed, maxDays }, 'gcp-billing-backfill: hit MAX_DAYS — re-run to continue');
  return { daysProcessed, eventsIngested, stoppedBecause: 'max-days' };
}

async function main(): Promise<void> {
  let exitCode = 0;
  try {
    await initSecrets();
    await initDatabase();
    const result = await runGcpBillingBackfill();
    log.info({ ...result }, 'gcp-billing-backfill: done');
    // A run that ingested nothing because the table is missing is a failure,
    // not a quiet success — the job must not report green.
    if (result.stoppedBecause === 'table-missing') exitCode = 1;
  } catch (err) {
    log.error({ err: (err as Error).message }, 'gcp-billing-backfill: failed');
    exitCode = 1;
  } finally {
    try {
      await closePools();
    } catch (err) {
      log.error({ err: (err as Error).message }, 'gcp-billing-backfill: closePools failed');
    }
  }
  process.exitCode = exitCode;
}

if (require.main === module) {
  void main();
}
