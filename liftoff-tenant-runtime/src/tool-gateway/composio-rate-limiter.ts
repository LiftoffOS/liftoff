// Composio quota enforcement.
//
// Composio bills ONE ORGANIZATION-WIDE meter — 20,000 tool calls/month and 100
// standard calls/min on the free tier — across every tenant, agent and
// endpoint on the platform. Two consequences shape this module:
//
//   * A per-tenant number is meaningless on its own. The org meter lives in
//     the control plane (composio-quota-client.ts fetches this tenant's slice);
//     enforcement happens here, locally, against that slice.
//   * BOTH meters have to be enforced. A rate limiter cannot protect a monthly
//     quota — a tenant well under 100/min can still spend a 20,000-call month
//     in a few days — and a monthly counter cannot protect a per-minute
//     ceiling.
//
// The per-minute bucket is in-memory per pod, so N pods enforce the rate N
// times independently. The monthly counter does not have that problem: it is
// reset from the control plane's authoritative figure on every refresh, so
// drift cannot accumulate past one TTL of traffic.

import { logger } from '../infrastructure/logging';
import {
  ensureAllocation,
  recordLocalConsumption,
  type ComposioQuotaAllocation,
} from './composio-quota-client';

/** Why a Composio call was refused. Mirrors the control plane's
 *  `ComposioQuotaDenialReason`. */
export type ComposioQuotaDenialReason =
  | 'tenant_rate_limited'
  | 'org_monthly_quota_exhausted'
  | 'background_reserve_protected'
  | 'tenant_monthly_slice_exhausted';

export interface RateLimitDecision {
  allowed: boolean;
  retryAfterMs?: number;
  reason?: ComposioQuotaDenialReason;
  /** Operator-readable explanation. Surfaced in the tool error so an exhausted
   *  quota reads as a platform decision rather than the unexplained vendor
   *  failure a bare Composio 429 looks like. */
  message?: string;
}

/**
 * Is this work something a person is waiting for?
 *
 * `cron` and `event` are ambient by definition: a scheduled run at 3am and a
 * connector webhook both proceed with nobody watching. They are exactly the
 * traffic that must not be what exhausts a shared monthly budget, so they are
 * refused once only the foreground reserve remains.
 *
 * `human` is a person waiting on an answer. `agent` is delegated work, which
 * sits underneath whatever triggered the parent — it is treated as foreground
 * because the alternative silently downgrades every delegated sub-task of a
 * live conversation.
 */
export function isBackgroundWork(triggeredBy: string | undefined): boolean {
  return triggeredBy === 'cron' || triggeredBy === 'event';
}

interface Bucket {
  tokens: number;
  lastRefill: number;
  /** The limit this bucket was sized for. When the allocation changes (a new
   *  tenant joins and everyone's share shrinks), the bucket is re-sized rather
   *  than continuing to refill toward a stale ceiling. */
  limit: number;
}

const buckets = new Map<string, Bucket>();

/** Per-minute token bucket, sized from the tenant's share of the ORG ceiling.
 *  The window matches the vendor's own unit, so the number here means the same
 *  thing as the number Composio enforces. */
function checkPerMinute(tenantId: string, perMinuteLimit: number): RateLimitDecision {
  const now = Date.now();
  const windowMs = 60_000;
  const refillPerMs = perMinuteLimit / windowMs;

  let b = buckets.get(tenantId);
  if (!b || b.limit !== perMinuteLimit) {
    b = { tokens: perMinuteLimit, lastRefill: now, limit: perMinuteLimit };
    buckets.set(tenantId, b);
  } else {
    const elapsed = now - b.lastRefill;
    b.tokens = Math.min(perMinuteLimit, b.tokens + elapsed * refillPerMs);
    b.lastRefill = now;
  }

  if (b.tokens >= 1) {
    b.tokens -= 1;
    return { allowed: true };
  }

  const retryAfterMs = Math.ceil((1 - b.tokens) / refillPerMs);
  return {
    allowed: false,
    retryAfterMs,
    reason: 'tenant_rate_limited',
    message:
      `This workspace is calling connected apps faster than its share of the platform's ` +
      `rate limit (${perMinuteLimit}/min). Retry in ${Math.ceil(retryAfterMs / 1000)}s.`,
  };
}

/** Monthly quota, evaluated against the control plane's allocation. Ordered
 *  most-fatal first so the message names the real constraint. */
function checkMonthly(
  allocation: ComposioQuotaAllocation,
  background: boolean,
): RateLimitDecision {
  const resetsOn = allocation.periodEnd
    ? new Date(allocation.periodEnd).toISOString().slice(0, 10)
    : 'the start of next month';

  if (allocation.orgRemaining <= 0) {
    return {
      allowed: false,
      reason: 'org_monthly_quota_exhausted',
      message:
        `Connected-app calls are unavailable: the platform's monthly allowance ` +
        `(${allocation.orgMonthlyQuota}) is fully consumed. It resets on ${resetsOn}.`,
    };
  }

  if (background && !allocation.backgroundAllowed) {
    return {
      allowed: false,
      reason: 'background_reserve_protected',
      message:
        `Scheduled and event-triggered work is paused: the platform's monthly ` +
        `allowance for connected apps is down to its reserve, which is held for ` +
        `work someone is waiting on. It resets on ${resetsOn}.`,
    };
  }

  // Past the guaranteed slice, a tenant may draw on the shared burst pool —
  // but only while the org is still above its reserve. Once it is not, the
  // reserve belongs to tenants still inside their own slice.
  if (allocation.tenantRemaining <= 0 && allocation.orgRemaining <= allocation.reservedHeadroom) {
    return {
      allowed: false,
      reason: 'tenant_monthly_slice_exhausted',
      message:
        `This workspace has used its monthly allowance for connected-app calls ` +
        `(${allocation.tenantMonthlySlice}) and the platform's shared pool is exhausted. ` +
        `It resets on ${resetsOn}.`,
    };
  }

  return { allowed: true };
}

/**
 * Check both meters and, when the call is allowed, consume one unit of each.
 *
 * Consuming on the ALLOW path (rather than after the vendor responds) is
 * deliberate: Composio bills per attempt, including failures, so an attempt is
 * the unit the budget is spent in. The dispatcher reports the same attempt to
 * the control plane, which is what the next refresh reconciles against.
 */
export async function checkComposioQuota(input: {
  tenantId: string;
  /** The run's trigger source. Absent is treated as foreground — a caller that
   *  does not say is not assumed to be ambient. */
  triggeredBy?: string;
}): Promise<RateLimitDecision> {
  // Awaited only on the first call for a tenant in this process; see
  // ensureAllocation. Refusing background work on a budget nobody had looked
  // up yet is the failure this replaces.
  const allocation = await ensureAllocation(input.tenantId);
  const background = isBackgroundWork(input.triggeredBy);

  const monthly = checkMonthly(allocation, background);
  if (!monthly.allowed) {
    logger.warn(
      {
        tenantId: input.tenantId,
        reason: monthly.reason,
        background,
        orgConsumed: allocation.orgConsumed,
        orgRemaining: allocation.orgRemaining,
        tenantConsumed: allocation.tenantConsumed,
        tenantMonthlySlice: allocation.tenantMonthlySlice,
      },
      'composio_monthly_quota_denied',
    );
    return monthly;
  }

  const perMinute = checkPerMinute(input.tenantId, allocation.perMinuteLimit);
  if (!perMinute.allowed) {
    logger.warn(
      {
        tenantId: input.tenantId,
        reason: perMinute.reason,
        retryAfterMs: perMinute.retryAfterMs,
        perMinuteLimit: allocation.perMinuteLimit,
        orgPerMinuteLimit: allocation.orgPerMinuteLimit,
      },
      'composio_tenant_rate_limited',
    );
    return perMinute;
  }

  recordLocalConsumption(input.tenantId, 1);
  return { allowed: true };
}

/** Test helper — clears in-memory buckets between tests. NOT for prod use. */
export function _resetForTesting(): void {
  buckets.clear();
}
