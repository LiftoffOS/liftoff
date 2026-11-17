// Composio quota allocation client.
//
// Composio's budget is ONE organization-wide meter — 20,000 tool calls/month
// and 100 standard calls/min on the free tier — across every tenant, agent and
// endpoint. This runtime is deployed per tenant with its own database and can
// see exactly one tenant's traffic, so it cannot hold that meter. The control
// plane can: every Composio dispatch already reports itself there
// (`reportComposioToolCall`), and the resulting ledger IS the org meter.
//
// This module is the read side of that loop. It fetches the tenant's slice,
// caches it for the TTL the control plane names, and NEVER blocks a tool call
// on the fetch: the hot path reads whatever is cached, and a refresh happens
// in the background when the cache goes stale.
//
// Degradation is deliberate and asymmetric:
//   * quota EXHAUSTED             -> fail closed with a clear platform error
//   * control plane UNREACHABLE   -> serve the last good allocation; if there
//                                    has never been one, fall back to
//                                    conservative local defaults with
//                                    background work refused.
// A control-plane blip must not take down every connector tool in the fleet,
// but it must not silently hand out an unlimited budget either.

import { logger } from '../infrastructure/logging';
import { getPlatformCallbackClient } from '../platform-callback/client';

/** Mirror of the control plane's `ComposioQuotaAllocation`
 *  (platform-backend src/composio-quota/types.ts). Kept as a local interface
 *  rather than a shared package because it crosses one HTTP boundary in one
 *  direction and every field is a plain number. */
export interface ComposioQuotaAllocation {
  orgMonthlyQuota: number;
  orgConsumed: number;
  orgRemaining: number;
  reservedHeadroom: number;
  backgroundAllowed: boolean;
  tenantMonthlySlice: number;
  tenantConsumed: number;
  tenantRemaining: number;
  burstPool: number;
  perMinuteLimit: number;
  orgPerMinuteLimit: number;
  tenantCount: number;
  periodStart: string;
  periodEnd: string;
  refreshAfterMs: number;
}

/**
 * What this runtime assumes when it has NEVER successfully reached the control
 * plane. Deliberately small: it is the budget for a runtime that cannot find
 * out what it is allowed to spend.
 *
 * 20/min is a fifth of the org's free-tier ceiling, so several runtimes in this
 * state still cannot exceed it together at any plausible fleet size. 500/month
 * is 2.5% of the org month. Background work is refused outright — ambient work
 * is exactly what must not run blind against a shared budget.
 */
const BLIND_FALLBACK: ComposioQuotaAllocation = {
  orgMonthlyQuota: 20_000,
  orgConsumed: 0,
  orgRemaining: 20_000,
  reservedHeadroom: 20_000,
  backgroundAllowed: false,
  tenantMonthlySlice: 500,
  tenantConsumed: 0,
  tenantRemaining: 500,
  burstPool: 0,
  perMinuteLimit: 20,
  orgPerMinuteLimit: 100,
  tenantCount: 0,
  periodStart: '',
  periodEnd: '',
  refreshAfterMs: 60_000,
};

interface CacheEntry {
  allocation: ComposioQuotaAllocation;
  /** When the cached value stops being authoritative and a refresh is due. */
  staleAt: number;
  /** False while the entry is BLIND_FALLBACK, i.e. no successful fetch yet. */
  fromControlPlane: boolean;
  /** Guards against a refresh storm when many calls land on a stale entry. */
  refreshing: boolean;
}

const cache = new Map<string, CacheEntry>();

function blindEntry(): CacheEntry {
  return {
    allocation: { ...BLIND_FALLBACK },
    staleAt: Date.now() + BLIND_FALLBACK.refreshAfterMs,
    fromControlPlane: false,
    refreshing: false,
  };
}

async function fetchAllocation(tenantId: string): Promise<ComposioQuotaAllocation | null> {
  const client = getPlatformCallbackClient();
  if (!client) return null;

  const resp = await client.fetch(
    'platform',
    `/api/internal/platform-tools/composio-quota?tenantId=${encodeURIComponent(tenantId)}`,
    { method: 'GET', breakerKey: 'platform:composio-quota' },
  );
  if (!resp.ok) {
    throw new Error(`HTTP ${resp.status}`);
  }
  return (await resp.json()) as ComposioQuotaAllocation;
}

/** Refresh in the background. Never awaited by the hot path; failures leave
 *  the existing entry in place and are logged once per attempt. */
function scheduleRefresh(tenantId: string, entry: CacheEntry): void {
  if (entry.refreshing) return;
  entry.refreshing = true;
  void fetchAllocation(tenantId)
    .then((allocation) => {
      if (!allocation) {
        // No platform callback configured (local dev). Keep the blind
        // fallback and stop asking every call.
        entry.staleAt = Date.now() + BLIND_FALLBACK.refreshAfterMs;
        return;
      }
      entry.allocation = allocation;
      entry.staleAt = Date.now() + Math.max(10_000, allocation.refreshAfterMs);
      entry.fromControlPlane = true;
    })
    .catch((err: Error) => {
      // Serve stale rather than fail: a control-plane hiccup must not take
      // every connector tool down with it. Back off before the next attempt so
      // an outage does not become a request storm.
      entry.staleAt = Date.now() + 30_000;
      logger.warn(
        { err: err.message, tenantId, servingStale: entry.fromControlPlane },
        'composio_quota_refresh_failed',
      );
    })
    .finally(() => {
      entry.refreshing = false;
    });
}

/** How long the first call for a tenant will wait to learn its real budget
 *  before falling back to the blind one. */
const FIRST_FETCH_TIMEOUT_MS = 3_000;

function withTimeout<T>(work: Promise<T>, ms: number): Promise<T> {
  return Promise.race([
    work,
    new Promise<T>((_, reject) =>
      setTimeout(() => reject(new Error(`allocation fetch exceeded ${ms}ms`)), ms).unref?.(),
    ),
  ]);
}

/**
 * The tenant's current allocation, waiting for the FIRST one and never again.
 *
 * The blind fallback refuses background work, which is right for a runtime
 * that asked and could not find out, and wrong for one that has not asked yet.
 * Those were the same state: the first call for a tenant got the fallback
 * synchronously while the fetch it started was still in flight. A scheduled
 * run makes one connector call on a container that has never served its
 * tenant, so it was refused on a budget nobody had checked — and the refusal
 * left no trace, because the refresh behind it then succeeded.
 *
 * So the first call waits, bounded. Every later call is served from cache with
 * no network hop, which is the property that mattered about being synchronous;
 * a single bounded wait per tenant per container is not a hot path.
 *
 * A fetch that FAILS still lands on the blind fallback. Not knowing is a
 * genuine reason to refuse ambient work against a shared budget.
 */
export async function ensureAllocation(tenantId: string): Promise<ComposioQuotaAllocation> {
  const existing = cache.get(tenantId);
  if (existing) {
    if (Date.now() >= existing.staleAt) scheduleRefresh(tenantId, existing);
    return existing.allocation;
  }

  const entry = blindEntry();
  cache.set(tenantId, entry);
  try {
    const allocation = await withTimeout(fetchAllocation(tenantId), FIRST_FETCH_TIMEOUT_MS);
    if (allocation) {
      entry.allocation = allocation;
      entry.staleAt = Date.now() + Math.max(10_000, allocation.refreshAfterMs);
      entry.fromControlPlane = true;
    } else {
      // No platform callback configured (local dev). Keep the blind fallback
      // and stop asking on every call.
      entry.staleAt = Date.now() + BLIND_FALLBACK.refreshAfterMs;
      logger.warn(
        { tenantId },
        'composio_quota_unconfigured_serving_blind',
      );
    }
  } catch (err) {
    entry.staleAt = Date.now() + 30_000;
    logger.warn(
      { err: (err as Error).message, tenantId },
      'composio_quota_first_fetch_failed',
    );
  }
  return entry.allocation;
}

/**
 * Record calls this runtime has made since the last refresh.
 *
 * The control plane's number is authoritative but up to one TTL old, and the
 * ledger it reads is written asynchronously. Counting locally in between means
 * a runtime that burns its slice inside one TTL window notices before the next
 * refresh instead of after it. The refresh then RESETS the local count to the
 * control plane's figure, so drift is bounded by one TTL of traffic rather
 * than accumulating.
 */
export function recordLocalConsumption(tenantId: string, calls = 1): void {
  const entry = cache.get(tenantId);
  if (!entry) return;
  entry.allocation.tenantConsumed += calls;
  entry.allocation.orgConsumed += calls;
  entry.allocation.tenantRemaining = Math.max(0, entry.allocation.tenantRemaining - calls);
  entry.allocation.orgRemaining = Math.max(0, entry.allocation.orgRemaining - calls);
  if (entry.allocation.orgRemaining <= entry.allocation.reservedHeadroom) {
    entry.allocation.backgroundAllowed = false;
  }
}

/** Test helper — clears cached allocations. NOT for prod use. */
export function _resetQuotaCacheForTesting(): void {
  cache.clear();
}

/** Test helper — seed an allocation without a control-plane round trip.
 *  NOT for prod use. */
export function _seedAllocationForTesting(
  tenantId: string,
  allocation: Partial<ComposioQuotaAllocation>,
): void {
  cache.set(tenantId, {
    allocation: { ...BLIND_FALLBACK, ...allocation },
    staleAt: Date.now() + 3_600_000,
    fromControlPlane: true,
    refreshing: false,
  });
}
