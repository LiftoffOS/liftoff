import { randomUUID } from 'crypto';
import type { WebVendor } from './types';
import { getPool } from '../../infrastructure/database';
import { getVendorConcurrencyLimits } from './limits-config';
import { getReleaseEmitter } from './notifier';
import { DEEP_RESEARCH_MAX_WAIT_MS } from './perplexity-client';

export interface InflightHandle {
  requestId: string;
  release: () => Promise<void>;
  refresh: () => Promise<{ refreshed: boolean }>;
}

// Returned when we waited the full budget and still couldn't admit. This is
// a soft "busy, try again momentarily" signal — NOT a tenant quota error.
// Callers translate to a retry-able response with retryAfterMs hint.
export class VendorPoolBusy extends Error {
  constructor(public vendor: WebVendor, public retryAfterMs: number) {
    super(`vendor_pool_busy:${vendor}`);
  }
}

// Per-request lifetime ceiling for the inflight row. If a request crashes,
// the row expires and the janitor reclaims the slot. 5min covers web_task's
// ~120s SLA with margin.
const DEFAULT_REQUEST_TTL_SECONDS = 300;
const DEEP_RESEARCH_TTL_SECONDS   = 3900;   // 65 min — must exceed DEEP_RESEARCH_MAX_WAIT_MS (60 min) + 60s margin

if (DEEP_RESEARCH_TTL_SECONDS * 1000 < DEEP_RESEARCH_MAX_WAIT_MS + 60_000) {
  throw new Error(
    `concurrency-limits invariant violated: DEEP_RESEARCH_TTL_SECONDS ` +
    `(${DEEP_RESEARCH_TTL_SECONDS}s) must exceed DEEP_RESEARCH_MAX_WAIT_MS ` +
    `(${DEEP_RESEARCH_MAX_WAIT_MS}ms) by at least 60s for release-block margin.`,
  );
}

function ttlSecondsFor(toolName: string): number {
  return toolName === 'web_deep_research'
    ? DEEP_RESEARCH_TTL_SECONDS
    : DEFAULT_REQUEST_TTL_SECONDS;
}

// Cooperative-wait parameters when the GLOBAL vendor cap is full. These are
// NOT user-facing limits — they exist solely to bound how long we block in
// the case where the vendor pool is saturated.
const WAIT_BUDGET_MS = 5_000;

// Safety fallback for the disconnect case where a NOTIFY is missed: re-arm
// once per second so a stuck waiter still tries `tryAdmit` periodically.
const FALLBACK_TICK_MS = 1_000;

/**
 * Admission with cooperative wait + fair scheduling.
 *
 * Per-vendor global cap is the only HARD limit and it is vendor-imposed.
 * Liftoff does NOT impose a per-tenant or per-agent cap — both can burst
 * up to the global ceiling. When the global cap is full we wait up to
 * WAIT_BUDGET_MS, then surface VendorPoolBusy (a soft signal, not a quota
 * error).
 */
export async function acquireInflightSlot(
  vendor: WebVendor,
  tenantId: string,
  agentId: string,
  toolName: string,
): Promise<InflightHandle> {
  const requestId = randomUUID();
  const waiterId  = randomUUID();
  const limits = await getVendorConcurrencyLimits(vendor);
  const pool = getPool();
  const deadline = Date.now() + WAIT_BUDGET_MS;

  // Insert ourselves into the waiter set so other replicas see we're queued.
  // expires_at protects against orphans if this process crashes mid-wait.
  const waiterTtlSec = Math.ceil(WAIT_BUDGET_MS / 1000) + 30;
  await pool.query(
    `INSERT INTO web_waiters (waiter_id, vendor, tenant_id, expires_at)
     VALUES ($1, $2, $3, NOW() + ($4 || ' seconds')::interval)`,
    [waiterId, vendor, tenantId, String(waiterTtlSec)],
  );

  // Subscribe to per-vendor release events BEFORE the first try, so we can't
  // miss a notification fired between our admit-fail and our listener attach.
  const releaseEvents = getReleaseEmitter();
  let wake!: () => void;
  let wakePromise = new Promise<void>(r => { wake = r; });
  const listener = (v: WebVendor) => { if (v === vendor) wake(); };
  releaseEvents.on('release', listener);

  try {
    // First attempt is immediate — common case is uncontended pool.
    if (await tryAdmit(pool, vendor, tenantId, agentId, toolName, requestId, limits, waiterId)) {
      return makeHandle(pool, requestId, toolName);
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
      const msLeft = deadline - Date.now();
      if (msLeft <= 0) throw new VendorPoolBusy(vendor, 1_000);

      const tickMs = Math.min(msLeft, FALLBACK_TICK_MS);
      await Promise.race([wakePromise, sleep(tickMs)]);
      wakePromise = new Promise<void>(r => { wake = r; });

      if (Date.now() >= deadline) throw new VendorPoolBusy(vendor, 1_000);

      if (await tryAdmit(pool, vendor, tenantId, agentId, toolName, requestId, limits, waiterId)) {
        return makeHandle(pool, requestId, toolName);
      }
    }
  } finally {
    releaseEvents.off('release', listener);
    await pool.query(`DELETE FROM web_waiters WHERE waiter_id = $1`, [waiterId]).catch(() => {});
  }
}

function makeHandle(
  pool: ReturnType<typeof getPool>,
  requestId: string,
  toolName: string,
): InflightHandle {
  return {
    requestId,
    release: async () => {
      // Delete + notify atomically. pg_notify is transactional — the NOTIFY
      // fires only when the transaction commits, so waiters see the slot as
      // free at the moment they wake.
      await pool.query(
        `WITH d AS (DELETE FROM web_inflight_requests WHERE request_id = $1 RETURNING vendor)
         SELECT pg_notify('web_fetch_release', vendor) FROM d`,
        [requestId],
      );
    },
    refresh: async () => {
      const r = await pool.query(
        `UPDATE web_inflight_requests
            SET expires_at = NOW() + ($2 || ' seconds')::interval
          WHERE request_id = $1
          RETURNING request_id`,
        [requestId, String(ttlSecondsFor(toolName))],
      );
      return { refreshed: (r.rowCount ?? 0) > 0 };
    },
  };
}

/**
 * Atomic check-and-admit under per-vendor advisory lock. Returns true if
 * this request was admitted, false if it should wait.
 *
 * Fair-share tiebreak: we admit only if this tenant's current inflight
 * count is <= the MIN inflight count across all tenants currently waiting
 * (including ourselves). Tenants with many in-flight requests yield to
 * tenants holding fewer — strict fair scheduling, no Liftoff-imposed cap.
 */
async function tryAdmit(
  pool: ReturnType<typeof getPool>,
  vendor: WebVendor,
  tenantId: string,
  agentId: string,
  toolName: string,
  requestId: string,
  limits: { maxConcurrentGlobal: number },
  waiterId: string,
): Promise<boolean> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtext('web_fetch_admission:' || $1))`,
      [vendor],
    );

    const { rows: [snap] } = await client.query(
      `SELECT
         (SELECT COUNT(*) FROM web_inflight_requests
            WHERE vendor = $1 AND expires_at > NOW())::int AS global_count,
         (SELECT COUNT(*) FROM web_inflight_requests
            WHERE vendor = $1 AND tenant_id = $2 AND expires_at > NOW())::int AS my_tenant_inflight,
         (SELECT COALESCE(MIN(t.cnt), 0) FROM (
            SELECT w.tenant_id,
              (SELECT COUNT(*) FROM web_inflight_requests
                 WHERE vendor = $1 AND tenant_id = w.tenant_id AND expires_at > NOW()) AS cnt
              FROM web_waiters w
              WHERE w.vendor = $1 AND w.expires_at > NOW()
              GROUP BY w.tenant_id
         ) t)::int AS min_waiter_tenant_inflight`,
      [vendor, tenantId],
    );

    if (snap.global_count >= limits.maxConcurrentGlobal) {
      await client.query('ROLLBACK');
      return false;
    }
    if (snap.my_tenant_inflight > snap.min_waiter_tenant_inflight) {
      await client.query('ROLLBACK');
      return false;
    }

    await client.query(
      `INSERT INTO web_inflight_requests (request_id, tenant_id, agent_id, vendor, tool_name, expires_at)
       VALUES ($1, $2, $3, $4, $5, NOW() + ($6 || ' seconds')::interval)`,
      [requestId, tenantId, agentId, vendor, toolName, String(ttlSecondsFor(toolName))],
    );
    await client.query(`DELETE FROM web_waiters WHERE waiter_id = $1`, [waiterId]);
    await client.query('COMMIT');
    return true;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}

function sleep(ms: number): Promise<void> { return new Promise(r => setTimeout(r, ms)); }
