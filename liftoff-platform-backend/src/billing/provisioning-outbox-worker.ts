// Provisioning Outbox Worker
//
// On the happy path, TenantService.activate() calls billing.provisionSubscription
// SYNCHRONOUSLY before returning the tenant to the frontend. The outbox is for
// the rare failure case (Stripe down, rate limit, network blip): activate()
// enqueues a row and continues; this worker retries with exponential backoff.
//
// Architecture:
//   - Fallback poll: setInterval every POLL_INTERVAL_MS (30s). Catches rows
//     enqueued while the platform-backend instance was restarting.
//   - In-process kick: kickProvisioningOutbox() uses setImmediate to run a
//     poll cycle right now. Called by TenantService.activate after enqueue
//     so retry latency on the happy-path-failure is sub-second.
//   - Claim mechanism: SELECT ... FOR UPDATE SKIP LOCKED ensures only one
//     instance processes a given row when platform-backend is horizontally scaled.
//   - Reaper: rows stuck in `in_progress` with stale `updated_at` (>5 min) get
//     reset to `pending`. Runs at the start of every runProvisioningOutboxOnce
//     so a crashed worker doesn't strand rows indefinitely.
//   - Backoff: 30s, 60s, 2m, 5m, 15m, 1h, 6h, 24h, 24h (9 retries → 10 attempts
//     total). After max_attempts, row.status = 'failed' and needs manual review.

import { withAdminScope } from '../infrastructure/database';
import { getBillingAdminClient, NoPaymentMethodError } from './billing-admin-client';
import { EntitlementService } from '../entitlements/service';
import { log } from '../infrastructure/logging';

const POLL_INTERVAL_MS = 30_000;
const BACKOFF_SECONDS = [30, 60, 120, 300, 900, 3600, 21600, 86400, 86400];

// Reaper threshold (minutes). Overridable via OUTBOX_REAPER_THRESHOLD_MIN
// for tests / environments that need a shorter window. Default 5.
function getReaperThresholdMinutes(): number {
  const raw = process.env.OUTBOX_REAPER_THRESHOLD_MIN;
  if (!raw) return 5;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n <= 0) return 5;
  return n;
}

// Cap the number of row IDs included in the reaper log line. The reaper
// normally touches a small handful of rows but in pathological cases (mass
// outage) the array could be large — we don't want to flood the logs.
const REAPER_LOG_ID_CAP = 20;

let intervalHandle: NodeJS.Timeout | null = null;

interface OutboxRow {
  id: string;
  tenant_id: string;
  account_id: string;
  action: string;
  attempts: number;
  max_attempts: number;
}

/**
 * Insert a pending row into provisioning_outbox. Called by TenantService.activate
 * when the inline provisionSubscription throws.
 *
 * Uses ON CONFLICT DO NOTHING against the partial unique index
 * `provisioning_outbox_unique_active` (migration 201) which covers
 * (tenant_id, action) where status IN ('pending', 'in_progress'). Re-enqueueing
 * the same action for a tenant whose previous row is still pending/in-progress
 * is a no-op rather than a duplicate that could double-provision a subscription.
 */
export async function enqueueProvisioningOutbox(
  tenantId: string,
  accountId: string,
): Promise<{ inserted: boolean }> {
  return await withAdminScope(
    {
      caller: 'enqueueProvisioningOutbox',
      reason: 'provisionSubscription failed inline; enqueue for retry',
    },
    async (client) => {
      const result = await client.query(
        `INSERT INTO provisioning_outbox (tenant_id, account_id, action)
         VALUES ($1, $2, 'provision_subscription')
         ON CONFLICT (tenant_id, action)
           WHERE status IN ('pending', 'in_progress')
           DO NOTHING`,
        [tenantId, accountId],
      );
      // rowCount=1 means INSERT happened; rowCount=0 means the partial-unique
      // index suppressed it because a pending/in_progress row already exists.
      return { inserted: (result.rowCount ?? 0) === 1 };
    },
  );
}

/**
 * Kick the worker to run immediately (via setImmediate, non-blocking).
 * Used by TenantService.activate after enqueue so the retry happens within
 * milliseconds rather than waiting for the next poll tick.
 */
export function kickProvisioningOutbox(): void {
  setImmediate(() => {
    runProvisioningOutboxOnce().catch((err) =>
      log.error(
        { error: (err as Error).message },
        'provisioning-outbox-worker kick failed',
      ),
    );
  });
}

/**
 * Reset rows stuck in `in_progress` whose updated_at is older than the threshold.
 * Runs at the start of every poll cycle so a worker that crashed mid-process
 * doesn't leave rows wedged forever. next_attempt_at is reset to NOW() so the
 * reaped row is immediately due for re-claim.
 */
async function reapStuckInProgress(): Promise<{ count: number; ids: string[] }> {
  return await withAdminScope(
    {
      caller: 'provisioning-outbox-worker.reap',
      reason: 'reset stuck in_progress rows',
    },
    async (client) => {
      const thresholdMin = getReaperThresholdMinutes();
      const r = await client.query<{ id: string }>(
        `UPDATE provisioning_outbox
         SET status = 'pending', next_attempt_at = NOW(), updated_at = NOW()
         WHERE status = 'in_progress'
           AND updated_at < NOW() - ($1 || ' minutes')::INTERVAL
         RETURNING id`,
        [String(thresholdMin)],
      );
      return { count: r.rowCount ?? 0, ids: r.rows.map((row) => row.id) };
    },
  );
}

/**
 * Run one pass over due rows. Claims and processes them one at a time
 * (FOR UPDATE SKIP LOCKED guarantees safety under horizontal scaling).
 * Returns when no more due rows are available.
 */
export async function runProvisioningOutboxOnce(): Promise<void> {
  const reaped = await reapStuckInProgress();
  if (reaped.count > 0) {
    const truncated = reaped.ids.length > REAPER_LOG_ID_CAP;
    const rowIds = truncated ? reaped.ids.slice(0, REAPER_LOG_ID_CAP) : reaped.ids;
    log.info(
      {
        reaped: reaped.count,
        rowIds,
        ...(truncated ? { rowIdsTruncated: true, totalReaped: reaped.count } : {}),
      },
      'provisioning-outbox: reset stuck in_progress rows',
    );
  }

  let processed = 0;
  while (true) {
    const row = await claimOne();
    if (!row) break;
    await processRow(row);
    processed += 1;
    if (processed > 50) {
      // Don't monopolize the worker — yield back to the event loop and let
      // the next poll tick (or kick) pick up the rest.
      log.info({ processed }, 'provisioning-outbox: yielding after 50 rows');
      break;
    }
  }
}

async function claimOne(): Promise<OutboxRow | null> {
  return await withAdminScope(
    { caller: 'provisioning-outbox-worker.claim', reason: 'claim due row' },
    async (client) => {
      // withAdminScope already opens a transaction (see packages/database/src/
      // tenant-scope.ts), so the FOR UPDATE SKIP LOCKED row-lock is held for
      // the duration of this UPDATE without an additional explicit BEGIN/COMMIT.
      //
      // attempts is NOT incremented here — claiming a row is not a "failed
      // attempt". The increment lives in markRetryOrFailed so it only fires
      // when we record a real failure. This makes attempts a clean count of
      // actual retries rather than claim-cycles.
      const r = await client.query<OutboxRow>(`
        UPDATE provisioning_outbox
        SET status = 'in_progress', updated_at = NOW()
        WHERE id = (
          SELECT id FROM provisioning_outbox
          WHERE status = 'pending' AND next_attempt_at <= NOW()
          ORDER BY next_attempt_at
          FOR UPDATE SKIP LOCKED
          LIMIT 1
        )
        RETURNING id, tenant_id, account_id, action, attempts, max_attempts
      `);
      return r.rows[0] ?? null;
    },
  );
}

async function processRow(row: OutboxRow): Promise<void> {
  try {
    if (row.action === 'provision_subscription') {
      await provisionSubscriptionAction(row);
    } else {
      throw new Error(`unknown outbox action: ${row.action}`);
    }
    try {
      await markCompleted(row.id);
    } catch (finalizeErr) {
      // CRITICAL: completion happened in Stripe but we couldn't flip the row.
      // The reaper will pick this up after STUCK_IN_PROGRESS_THRESHOLD and the
      // next attempt will see alreadyExists=true and converge. Do NOT rethrow
      // so the runOnce loop keeps processing the next row.
      log.error(
        {
          outboxId: row.id,
          tenantId: row.tenant_id,
          error: (finalizeErr as Error).message,
        },
        'provisioning-outbox: CRITICAL — markCompleted failed AFTER successful provision; reaper will reset row, next attempt should converge via alreadyExists',
      );
    }
    log.info(
      { outboxId: row.id, tenantId: row.tenant_id, attempts: row.attempts },
      'provisioning-outbox: row completed',
    );
  } catch (err) {
    // Terminal-but-expected: the customer has no payment method, so no number
    // of retries can provision this subscription — only the user entering a
    // card at the wizard's payment step can, and that path calls /subscribe
    // directly. Close the row instead of spending the remaining attempts over
    // the next two days. `deferred` rather than `failed` so a row like this
    // never shows up in an ops count of genuine provisioning failures.
    //
    // This is also what retires rows enqueued BEFORE activate() learned to skip
    // them, so the fix drains the existing backlog rather than only stopping
    // new arrivals.
    if (err instanceof NoPaymentMethodError) {
      try {
        await markDeferred(row.id, 'no_payment_method: awaiting onboarding payment step');
      } catch (finalizeErr) {
        // Same contract as the branches below: the reaper resets the row and
        // the next attempt lands here again, which is harmless and idempotent.
        log.error(
          {
            outboxId: row.id,
            tenantId: row.tenant_id,
            finalizeError: (finalizeErr as Error).message,
          },
          'provisioning-outbox: markDeferred failed; row left in_progress, reaper will reset',
        );
      }
      log.info(
        { outboxId: row.id, tenantId: row.tenant_id, attempts: row.attempts },
        'provisioning-outbox: row deferred — customer has no payment method; the onboarding payment step will provision via /subscribe',
      );
      return;
    }

    // attempts hasn't been incremented yet (we removed the bump from claimOne),
    // so the boundary is attempts + 1 >= max_attempts.
    const finalAttempt = row.attempts + 1 >= row.max_attempts;
    const backoffIdx = Math.min(row.attempts, BACKOFF_SECONDS.length - 1);
    const backoffSec = finalAttempt ? null : BACKOFF_SECONDS[backoffIdx];
    try {
      await markRetryOrFailed(row.id, finalAttempt, backoffSec, (err as Error).message);
    } catch (finalizeErr) {
      // CRITICAL: we know the provision failed but couldn't persist the retry/fail
      // metadata. The reaper will reset the row from in_progress → pending and the
      // next claim will retry. Don't rethrow.
      log.error(
        {
          outboxId: row.id,
          tenantId: row.tenant_id,
          finalAttempt,
          originalError: (err as Error).message,
          finalizeError: (finalizeErr as Error).message,
        },
        'provisioning-outbox: CRITICAL — markRetryOrFailed failed; row left in_progress, reaper will reset',
      );
    }
    log.error(
      {
        outboxId: row.id,
        tenantId: row.tenant_id,
        attempts: row.attempts + 1,
        finalAttempt,
        error: (err as Error).message,
      },
      finalAttempt
        ? 'provisioning-outbox: row FAILED — max attempts exceeded; manual intervention required'
        : 'provisioning-outbox: row retry scheduled',
    );
  }
}

async function provisionSubscriptionAction(row: OutboxRow): Promise<void> {
  // Read stripe_customer_id from accounts (platform-global, no RLS)
  const stripeCustomerId = await withAdminScope(
    { caller: 'provisioning-outbox-worker.lookup', reason: 'fetch stripe_customer_id' },
    async (client) => {
      const r = await client.query<{ stripe_customer_id: string | null }>(
        'SELECT stripe_customer_id FROM accounts WHERE id = $1',
        [row.account_id],
      );
      return r.rows[0]?.stripe_customer_id ?? null;
    },
  );

  if (!stripeCustomerId) {
    throw new Error(`account ${row.account_id} missing stripe_customer_id`);
  }

  const { alreadyExists } = await getBillingAdminClient()
    .provisionSubscription(row.tenant_id, stripeCustomerId);

  if (alreadyExists) {
    // Through the service, not a raw UPDATE: the raw form left `version`
    // unchanged and published no event, so the runtime's cached entitlement
    // never learned the tenant had been cleared to run agents. The service
    // opens its own tenant scope, so app.current_tenant_id being unset on this
    // connection is not a problem.
    await new EntitlementService().enableAgentExecution(row.tenant_id);
  }
}

async function markCompleted(id: string): Promise<void> {
  await withAdminScope(
    { caller: 'provisioning-outbox-worker.complete', reason: 'mark row completed' },
    (client) =>
      client.query(
        `UPDATE provisioning_outbox
         SET status = 'completed', completed_at = NOW(), updated_at = NOW(), last_error = NULL
         WHERE id = $1`,
        [id],
      ),
  );
}

/**
 * Close a row that cannot be provisioned yet because the customer has no
 * payment method. `completed_at` is deliberately left NULL — nothing was
 * provisioned — and `attempts` is NOT incremented, because this was not a
 * failed attempt at something achievable. `last_error` carries the reason so
 * an operator reading the row knows why it stopped.
 *
 * The partial unique index `provisioning_outbox_unique_active` covers only
 * ('pending', 'in_progress'), so a deferred row does not block a legitimate
 * re-enqueue later.
 */
async function markDeferred(id: string, reason: string): Promise<void> {
  await withAdminScope(
    { caller: 'provisioning-outbox-worker.defer', reason: 'mark row deferred' },
    (client) =>
      client.query(
        `UPDATE provisioning_outbox
         SET status = 'deferred', last_error = $2, updated_at = NOW()
         WHERE id = $1`,
        [id, reason.slice(0, 500)],
      ),
  );
}

async function markRetryOrFailed(
  id: string,
  finalAttempt: boolean,
  backoffSec: number | null,
  errorMessage: string,
): Promise<void> {
  await withAdminScope(
    { caller: 'provisioning-outbox-worker.retry_or_fail', reason: 'mark row retry/fail' },
    (client) =>
      client.query(
        `UPDATE provisioning_outbox
         SET status = $2,
             attempts = attempts + 1,
             last_error = $3,
             updated_at = NOW(),
             next_attempt_at = CASE
               WHEN $4::int IS NULL THEN next_attempt_at
               ELSE NOW() + ($4 || ' seconds')::interval
             END
         WHERE id = $1`,
        [id, finalAttempt ? 'failed' : 'pending', errorMessage.slice(0, 500), backoffSec],
      ),
  );
}

/**
 * Start the fallback polling loop. Called once from src/index.ts on boot.
 * Returns the interval handle so tests / shutdown can clear it.
 */
export function startProvisioningOutboxLoop(): NodeJS.Timeout {
  // isRunning guard: a second call would otherwise overwrite intervalHandle
  // and leak the original interval (it would keep firing with no way to clear it).
  if (intervalHandle) {
    log.warn(
      { intervalMs: POLL_INTERVAL_MS },
      'startProvisioningOutboxLoop called while already running, skipping',
    );
    return intervalHandle;
  }
  intervalHandle = setInterval(() => {
    runProvisioningOutboxOnce().catch((err) =>
      log.error(
        { error: (err as Error).message },
        'provisioning-outbox-worker tick failed',
      ),
    );
  }, POLL_INTERVAL_MS);
  log.info({ intervalMs: POLL_INTERVAL_MS }, 'provisioning-outbox-worker started');
  return intervalHandle;
}

export function stopProvisioningOutboxLoop(): void {
  if (intervalHandle) {
    clearInterval(intervalHandle);
    intervalHandle = null;
  }
}
