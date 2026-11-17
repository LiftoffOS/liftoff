// Composio quota governance — allocation.
//
// Turns the org-wide meter into ONE TENANT'S allocation. The runtime enforces
// against that allocation locally, so this never sits on a tool call's hot
// path; it is polled on a TTL and its answer is cached.
//
// Four properties this has to hold, in the order they matter:
//
//  1. BOTH meters. A rate limiter cannot protect a monthly quota and a monthly
//     counter cannot protect a per-minute ceiling. The allocation carries one
//     number for each.
//  2. NEVER above the org ceiling. `perMinuteLimit` is clamped to the org's
//     own per-minute ceiling, always — a per-tenant number derived without
//     that clamp can authorise one tenant to consume more than the whole
//     platform is allowed.
//  3. Reserved headroom that background work cannot touch. Ambient work is by
//     definition the work nobody is waiting for; it must not be what exhausts
//     the month.
//  4. Per-workspace consumption, so a runaway tenant is diagnosable and a tier
//     decision has evidence behind it.

import { log } from '../infrastructure/logging';
import {
  allocationTtlMs,
  guaranteedFraction,
  minTenantPerMinute,
  orgMonthlyQuota,
  orgPerMinuteLimit,
  reservedHeadroom,
} from './config';
import { getActiveTenantCount, getOrgConsumption, type OrgConsumption } from './repository';
import type { ComposioQuotaAllocation } from './types';

/** Cached org-wide read, shared by every tenant asking in the same window.
 *  One control-plane query serves the whole fleet's refresh cycle. */
interface OrgSnapshot {
  consumption: OrgConsumption;
  tenantCount: number;
  expiresAt: number;
}

let cachedOrg: OrgSnapshot | null = null;
let inFlight: Promise<OrgSnapshot> | null = null;

/** Shorter than the runtime's own allocation TTL on purpose: the control plane
 *  should never be the reason a runtime's number is staler than the runtime
 *  thinks it is. */
const ORG_SNAPSHOT_TTL_MS = 60_000;

/** Workspaces named in the consumption log. Enough to identify a runaway and
 *  to argue a tier decision; short enough that the line stays readable. */
const TOP_CONSUMERS_LOGGED = 10;

async function loadOrgSnapshot(now: Date): Promise<OrgSnapshot> {
  const [consumption, tenantCount] = await Promise.all([
    getOrgConsumption(now),
    getActiveTenantCount(),
  ]);

  // Per-workspace consumption, emitted once per snapshot refresh rather than
  // per request — the whole point of metering a shared budget is being able to
  // say WHICH workspace is spending it. Computing this breakdown and then
  // returning only the caller's own number would leave "which tenant is the
  // runaway" and "is a paid tier worth it" unanswerable from anything we keep.
  const ranked = [...consumption.perTenant.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TOP_CONSUMERS_LOGGED)
    .map(([tenantId, calls]) => ({ tenantId, calls }));

  log.info(
    {
      metric: 'composio.quota.org_snapshot',
      orgCalls: consumption.orgCalls,
      orgMonthlyQuota: orgMonthlyQuota(),
      activeTenants: tenantCount,
      consumingTenants: consumption.perTenant.size,
      topConsumers: ranked,
      periodStart: consumption.periodStart.toISOString(),
      periodEnd: consumption.periodEnd.toISOString(),
    },
    'Composio org-wide consumption snapshot',
  );

  return { consumption, tenantCount, expiresAt: Date.now() + ORG_SNAPSHOT_TTL_MS };
}

async function orgSnapshot(now: Date): Promise<OrgSnapshot> {
  if (cachedOrg && cachedOrg.expiresAt > Date.now()) return cachedOrg;
  // Single in-flight load: a fleet-wide refresh storm must not turn into N
  // identical cross-tenant aggregations.
  if (!inFlight) {
    inFlight = loadOrgSnapshot(now)
      .then((snap) => {
        cachedOrg = snap;
        return snap;
      })
      .finally(() => {
        inFlight = null;
      });
  }
  return inFlight;
}

/** Drop the cached org snapshot. Test-only: nothing in production wants a
 *  reading younger than the snapshot TTL, and an operator path that did would
 *  need its own endpoint rather than a reach into module state. */
export function _resetComposioQuotaCacheForTesting(): void {
  cachedOrg = null;
  inFlight = null;
}

/**
 * Compute one tenant's slice of the org-wide Composio budget.
 *
 * Pure arithmetic over the snapshot, so the whole policy is readable in one
 * place and unit-testable without a database.
 */
export function computeAllocation(input: {
  tenantId: string;
  consumption: OrgConsumption;
  tenantCount: number;
}): ComposioQuotaAllocation {
  const quota = orgMonthlyQuota();
  const reserve = Math.min(reservedHeadroom(), quota);
  const orgCeilingPerMinute = orgPerMinuteLimit();

  const orgConsumed = input.consumption.orgCalls;
  const orgRemaining = Math.max(0, quota - orgConsumed);

  // Spendable = everything outside the foreground reserve. Guaranteed slices
  // are carved from the spendable part only, so the reserve can never be
  // pre-committed to a tenant that then spends it on background work.
  const spendable = Math.max(0, quota - reserve);
  const guaranteedPool = Math.floor(spendable * guaranteedFraction());
  const tenantMonthlySlice = Math.floor(guaranteedPool / Math.max(1, input.tenantCount));
  const burstPool = Math.max(0, spendable - guaranteedPool);

  const tenantConsumed = input.consumption.perTenant.get(input.tenantId) ?? 0;
  const tenantRemaining = Math.max(0, tenantMonthlySlice - tenantConsumed);

  // The floor keeps a large fleet usable; the clamp keeps the floor from ever
  // authorising a single tenant to exceed what the whole organization is
  // allowed.
  const fairPerMinute = Math.floor(orgCeilingPerMinute / Math.max(1, input.tenantCount));
  const perMinuteLimit = Math.min(
    orgCeilingPerMinute,
    Math.max(fairPerMinute, minTenantPerMinute()),
  );

  return {
    orgMonthlyQuota: quota,
    orgConsumed,
    orgRemaining,
    reservedHeadroom: reserve,
    backgroundAllowed: orgRemaining > reserve,
    tenantMonthlySlice,
    tenantConsumed,
    tenantRemaining,
    burstPool,
    perMinuteLimit,
    orgPerMinuteLimit: orgCeilingPerMinute,
    tenantCount: input.tenantCount,
    periodStart: input.consumption.periodStart.toISOString(),
    periodEnd: input.consumption.periodEnd.toISOString(),
    refreshAfterMs: allocationTtlMs(),
  };
}

/** Read the org meter and return this tenant's allocation. */
export async function getComposioQuotaAllocation(
  tenantId: string,
  now: Date = new Date(),
): Promise<ComposioQuotaAllocation> {
  const snap = await orgSnapshot(now);
  const allocation = computeAllocation({
    tenantId,
    consumption: snap.consumption,
    tenantCount: snap.tenantCount,
  });

  // Logged at the point the org number is known, so exhaustion is visible in
  // the control plane's own logs and not only in whichever runtime happened to
  // ask last.
  if (!allocation.backgroundAllowed) {
    log.warn(
      {
        metric: 'composio.quota.background_reserve_reached',
        orgConsumed: allocation.orgConsumed,
        orgMonthlyQuota: allocation.orgMonthlyQuota,
        reservedHeadroom: allocation.reservedHeadroom,
        periodEnd: allocation.periodEnd,
      },
      'Composio monthly quota is down to the foreground reserve — background work is refused platform-wide',
    );
  }

  return allocation;
}
