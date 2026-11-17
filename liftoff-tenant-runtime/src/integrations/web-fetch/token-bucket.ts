import { getPool } from '../../infrastructure/database';
import { getVendorRatePerHour, getVendorBurst, rateBudgetFor } from './limits-config';
import { CONNECTOR_TYPE_OF } from './vendor-order';
import type { WebVendor } from './types';

export interface RateCheckResult {
  ok: boolean;
  retryAfterMs?: number;
}

/** How long a caller will wait for one token before being told the vendor is
 *  busy. A vendor whose real ceiling is a request a second refuses roughly
 *  every call a run makes, and a refusal is only the right answer when waiting
 *  would take longer than the call itself. Mirrors the concurrency layer's
 *  WAIT_BUDGET_MS so the two admission axes behave the same way. */
const RATE_WAIT_BUDGET_MS = 5_000;

/** Cap on one sleep, so a bucket that reports a long deficit is re-read rather
 *  than trusted for the whole wait: other callers drain and refill it while we
 *  are asleep. */
const RATE_WAIT_SLICE_MS = 250;

/** The bucket a call spends from.
 *
 *  Two things it is NOT keyed on, each a defect when it was:
 *
 *  - the TOOL NAME, when several tools share one vendor endpoint. The budget
 *    belongs to the endpoint; `rateBudgetFor` resolves the shared name.
 *  - the TENANT, when the vendor's limit belongs to a key every tenant shares.
 *    `CONNECTOR_TYPE_OF[vendor] === null` is exactly the platform-managed
 *    case: a customer cannot hold a key for our account, so there is one
 *    key and one ceiling. A per-tenant bucket against it permits the real
 *    ceiling multiplied by the tenant count, which is not a limit.
 */
export function bucketKeyFor(tenantId: string, vendor: WebVendor, toolName: string): string {
  const budget = rateBudgetFor(vendor, toolName);
  const scope = CONNECTOR_TYPE_OF[vendor] === null ? 'platform' : tenantId;
  return `${scope}:${vendor}:${budget}`;
}

/**
 * Atomic token-bucket consume in a single statement. Refills based on
 * elapsed wall-clock since last_refilled_at; only commits if there's at
 * least 1 token left after the refill.
 *
 * Bucket initialization is lazy: the UPSERT inserts a fresh-full bucket on
 * first call, then the second branch of ON CONFLICT does the refill+consume.
 *
 * Granularity: see `bucketKeyFor`. Per-agent buckets would be unbounded
 * (tenants will have 30-50+ agents); vendor-level concurrency caps already
 * provide per-tenant fairness on the concurrency axis.
 *
 * An empty bucket WAITS up to `waitBudgetMs` rather than refusing immediately.
 * A rate this layer exists to respect is often a request a second, and
 * refusing a call that one second would have admitted sends the vendor's
 * ceiling to the model as a tool failure.
 *
 * The budget is the CALLER'S to set, because only the caller knows whether
 * waiting is the best available answer. A router with another vendor behind
 * this one should pass 0 and fall through: holding the call while a different
 * backend could serve it now is strictly worse than moving on. A vendor that
 * is the only one serving the tool has nothing to fall through to, and there
 * waiting is what makes the call succeed.
 */
export async function consumeToken(
  tenantId: string,
  vendor: WebVendor,
  toolName: string,
  waitBudgetMs: number = RATE_WAIT_BUDGET_MS,
): Promise<RateCheckResult> {
  const deadline = Date.now() + Math.max(0, waitBudgetMs);
  for (;;) {
    const attempt = await tryConsume(tenantId, vendor, toolName);
    if (attempt.ok) return attempt;
    const remaining = deadline - Date.now();
    // Not worth waiting for: either we are out of budget, or the bucket says
    // the token is further away than the caller is prepared to wait.
    if (remaining <= 0 || (attempt.retryAfterMs ?? 0) > remaining) return attempt;
    await sleep(Math.min(RATE_WAIT_SLICE_MS, Math.max(1, attempt.retryAfterMs ?? RATE_WAIT_SLICE_MS)));
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function tryConsume(
  tenantId: string,
  vendor: WebVendor,
  toolName: string,
): Promise<RateCheckResult> {
  const ratePerHour = await getVendorRatePerHour(vendor, toolName);
  if (!ratePerHour) return { ok: true };

  // Capacity is the BURST the vendor allows, and refill is the sustained rate.
  // Conflating the two — capacity = ratePerHour — means the hour's whole
  // allowance may be spent at once, so a bucket sized for a vendor that admits
  // one call a second admitted 3,600 back to back and paced nothing that a run
  // would ever notice. Vendors that publish no burst keep the old behaviour.
  const burst = await getVendorBurst(vendor, toolName);
  const capacity = burst ?? ratePerHour;
  const refillPerSec = ratePerHour / 3600;
  const bucketKey = bucketKeyFor(tenantId, vendor, toolName);

  const { rows } = await getPool().query(
    `INSERT INTO token_buckets (bucket_key, tokens, capacity, refill_rate_per_sec, last_refilled_at)
     VALUES ($1, $2 - 1, $2, $3, NOW())
     ON CONFLICT (bucket_key) DO UPDATE
       SET capacity = EXCLUDED.capacity,
           refill_rate_per_sec = EXCLUDED.refill_rate_per_sec,
           tokens = LEAST(
             EXCLUDED.capacity,
             token_buckets.tokens + EXTRACT(EPOCH FROM (NOW() - token_buckets.last_refilled_at)) * token_buckets.refill_rate_per_sec
           ) - 1,
           last_refilled_at = NOW()
       WHERE LEAST(
         EXCLUDED.capacity,
         token_buckets.tokens + EXTRACT(EPOCH FROM (NOW() - token_buckets.last_refilled_at)) * token_buckets.refill_rate_per_sec
       ) >= 1
     RETURNING tokens`,
    [bucketKey, capacity, refillPerSec],
  );

  if (rows.length === 0) {
    // Bucket was empty after refill. Compute time until 1 token recovers.
    const { rows: [b] } = await getPool().query(
      `SELECT tokens, refill_rate_per_sec, last_refilled_at FROM token_buckets WHERE bucket_key = $1`,
      [bucketKey],
    );
    if (!b) return { ok: false, retryAfterMs: 1_000 };
    const elapsedSec = (Date.now() - new Date(b.last_refilled_at).getTime()) / 1000;
    const currentTokens = b.tokens + elapsedSec * b.refill_rate_per_sec;
    const deficit = 1 - currentTokens;
    const retryAfterMs = Math.max(0, deficit / b.refill_rate_per_sec) * 1000;
    return { ok: false, retryAfterMs };
  }
  return { ok: true };
}
