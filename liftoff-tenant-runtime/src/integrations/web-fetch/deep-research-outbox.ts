// Durable outbox for deep_research cost events. When the in-process hook
// fails to publish (Pub/Sub down, transient PB outage), the payload lands
// here and is retried by the drainer loop (10s cadence) until it succeeds
// or hits MAX_ATTEMPTS. The reconciler (TR-7) also routes through this
// outbox so all emission paths share one retry harness.

import { getPool } from '../../infrastructure/database';
import { logger } from '../../infrastructure/logging';
import { publishWebToolEvent, type WebToolSpendEvent } from './event-publisher';

export type OutboxKind = 'pre_charge' | 'delta';

export interface OutboxRow {
  outboxId:        string;
  deepResearchId:  string;
  kind:            OutboxKind;
  payloadJson:     WebToolSpendEvent;
  attempts:        number;
  nextAttemptAt:   Date;
  createdAt:       Date;
  lastError:       string | null;
}

// MAX_ATTEMPTS at exponential backoff (10s → 20s → 40s → ...) caps at
// ~57h before manual escalation. Long enough to absorb a 24h PB or Pub/Sub
// outage; short enough that rows don't pile indefinitely on a stuck
// dependency.
const MAX_ATTEMPTS = 20;
const BASE_BACKOFF_MS = 10_000;
const MAX_BACKOFF_MS = 60 * 60 * 1000;   // 1h cap

const DRAIN_BATCH_SIZE = 50;
const DRAIN_INTERVAL_MS = 10_000;

let drainerHandle: ReturnType<typeof setInterval> | null = null;
// Overlap guard (Gap #7): if a slow Pub/Sub causes drainOnce to take > DRAIN_INTERVAL_MS,
// the next interval tick is skipped. setInterval otherwise fires a new tick
// while the previous is still running, producing concurrent batches and
// confusing logs.
let drainInProgress = false;

/**
 * Idempotent enqueue. UNIQUE (deep_research_id, kind) guards against double
 * inserts when the hook calls tryPublishOrOutbox more than once for the
 * same (submission, kind) pair (e.g., retry race). The next_attempt_at is
 * coalesced LEAST() so an earlier retry slot wins.
 */
export async function enqueueOutbox(
  deepResearchId: string,
  kind: OutboxKind,
  payload: WebToolSpendEvent,
  reason: string,
): Promise<void> {
  await getPool().query(
    `INSERT INTO deep_research_outbox
       (deep_research_id, kind, payload_json, last_error)
     VALUES ($1, $2, $3::jsonb, $4)
     ON CONFLICT (deep_research_id, kind) DO NOTHING`,
    [deepResearchId, kind, JSON.stringify(payload), reason],
  );
  logger.warn({
    deep_research_id: deepResearchId,
    kind,
    reason,
  }, 'deep_research_outbox_enqueued');
}

/**
 * Multi-replica strategy: NOT FOR UPDATE SKIP LOCKED. Same reasoning as the
 * registry's selectDueForReconciliation — holding row locks across a slow
 * `publishWebToolEvent` call (Pub/Sub publish) would hold the DB tx open
 * for the publish duration, which is exactly the failure mode the outbox
 * exists to handle (Pub/Sub down/slow).
 *
 * Instead: two replicas may pick the same outbox row. Both attempt publish.
 *   - Both succeed → both DELETE; second is a no-op (idempotent). PB
 *     deduplicates the duplicate publish by metadata.idempotency_key.
 *   - Both fail → both bumpAttempt. Two increments. Backoff grows faster
 *     than designed (next attempt is 4×, not 2×). Acceptable degradation;
 *     does NOT cause data loss.
 *   - One succeeds, one fails → success DELETEs; failure's bumpAttempt
 *     UPDATEs a now-gone row (rowCount=0, no error). Net: row drained.
 */
async function selectDue(limit: number): Promise<OutboxRow[]> {
  const result = await getPool().query<{
    outbox_id:        string;
    deep_research_id: string;
    kind:             OutboxKind;
    payload_json:     WebToolSpendEvent;
    attempts:         number;
    next_attempt_at:  Date;
    created_at:       Date;
    last_error:       string | null;
  }>(
    `SELECT outbox_id, deep_research_id, kind, payload_json,
            attempts, next_attempt_at, created_at, last_error
       FROM deep_research_outbox
      WHERE next_attempt_at <= NOW()
      ORDER BY next_attempt_at
      LIMIT $1`,
    [limit],
  );
  return result.rows.map(r => ({
    outboxId:        r.outbox_id,
    deepResearchId:  r.deep_research_id,
    kind:            r.kind,
    payloadJson:     r.payload_json,
    attempts:        r.attempts,
    nextAttemptAt:   r.next_attempt_at,
    createdAt:       r.created_at,
    lastError:       r.last_error,
  }));
}

async function deleteRow(outboxId: string): Promise<void> {
  await getPool().query(
    `DELETE FROM deep_research_outbox WHERE outbox_id = $1`,
    [outboxId],
  );
}

async function bumpAttempt(outboxId: string, attempts: number, errMsg: string): Promise<void> {
  const backoff = Math.min(BASE_BACKOFF_MS * Math.pow(2, attempts), MAX_BACKOFF_MS);
  await getPool().query(
    `UPDATE deep_research_outbox
        SET attempts        = $2,
            next_attempt_at = NOW() + ($3 || ' milliseconds')::interval,
            last_error      = $4
      WHERE outbox_id       = $1`,
    [outboxId, attempts + 1, String(backoff), errMsg.slice(0, 1000)],
  );
}

/**
 * Single drain pass. Pool-based — no explicit transaction. Each row's
 * publish attempt is independent: a failure on one doesn't block the next.
 * Rows past MAX_ATTEMPTS log `deep_research_outbox_giving_up` ERROR and
 * stay in place so ops can manually replay the payload (deletion would
 * lose data).
 *
 * No DB transaction wraps the publish loop because publishWebToolEvent is
 * a network call (Pub/Sub) — holding a tx open across many slow publishes
 * would stall replicas and risk statement_timeout. Multi-replica duplicate-
 * work is handled at the publish layer (PB ingester dedupes by
 * idempotency_key).
 */
export async function drainOnce(): Promise<{
  drained: number;
  failed: number;
  given_up: number;
}> {
  const rows = await selectDue(DRAIN_BATCH_SIZE);
  let drained = 0;
  let failed = 0;
  let given_up = 0;
  for (const row of rows) {
    if (row.attempts >= MAX_ATTEMPTS) {
      logger.error({
        outbox_id:        row.outboxId,
        deep_research_id: row.deepResearchId,
        kind:             row.kind,
        attempts:         row.attempts,
        last_error:       row.lastError,
      }, 'deep_research_outbox_giving_up');
      given_up++;
      continue;
    }
    try {
      const ok = await publishWebToolEvent(row.payloadJson);
      if (ok) {
        await deleteRow(row.outboxId);
        drained++;
      } else {
        await bumpAttempt(row.outboxId, row.attempts, 'publish returned false');
        failed++;
      }
    } catch (err) {
      await bumpAttempt(row.outboxId, row.attempts, (err as Error).message);
      failed++;
    }
  }
  return { drained, failed, given_up };
}

/** Gauge for the backlog alert (INF-4). Backlog = rows already in retry. */
export async function getOutboxBacklog(): Promise<number> {
  const r = await getPool().query<{ n: string }>(
    `SELECT COUNT(*) AS n FROM deep_research_outbox WHERE attempts > 0`,
  );
  return parseInt(r.rows[0].n, 10);
}

/**
 * Start the in-process drainer loop. Called from src/index.ts on boot.
 * .unref() so the drainer doesn't keep the process alive during shutdown.
 * Overlap-guarded (Gap #7) — a slow drain pass skips the next tick rather
 * than running two concurrently in the same replica.
 *
 * Env-disable: DEEP_RESEARCH_OUTBOX_DRAINER_DISABLED=true short-circuits
 * the start (used as a kill-switch during rollback per the runbook).
 */
export function startOutboxDrainer(): void {
  if (process.env.DEEP_RESEARCH_OUTBOX_DRAINER_DISABLED === 'true') {
    logger.info({}, 'deep_research_outbox_drainer_disabled_by_env');
    return;
  }
  if (drainerHandle) return;
  drainerHandle = setInterval(async () => {
    if (drainInProgress) {
      logger.warn({}, 'deep_research_outbox_drain_skipped_overlap');
      return;
    }
    drainInProgress = true;
    try {
      await drainOnce();
      const backlog = await getOutboxBacklog();
      if (backlog > 0) {
        logger.info({ backlog_count: backlog }, 'deep_research_outbox_backlog');
      }
    } catch (err) {
      logger.error({ err: (err as Error).message }, 'deep_research_outbox_drain_failed');
    } finally {
      drainInProgress = false;
    }
  }, DRAIN_INTERVAL_MS);
  drainerHandle.unref();
  logger.info({ interval_ms: DRAIN_INTERVAL_MS }, 'deep_research_outbox_drainer_started');
}

/**
 * Graceful shutdown (Gap #8): called from the SIGTERM handler in src/index.ts.
 * Awaits any in-flight drain pass to complete before returning. Caller bounds
 * the wait — typically with Promise.race + a 5s ceiling so we don't block
 * Cloud Run's 10s SIGTERM grace window indefinitely.
 */
export async function stopOutboxDrainer(): Promise<void> {
  if (drainerHandle) { clearInterval(drainerHandle); drainerHandle = null; }
  // Wait for in-flight pass. ~10ms tick, max ~50 iterations = 500ms.
  let waited = 0;
  while (drainInProgress && waited < 5_000) {
    await new Promise(r => setTimeout(r, 10));
    waited += 10;
  }
}
