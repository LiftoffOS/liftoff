// Composio quota governance — configuration.
//
// Defaults are Composio's FREE-TIER limits. When a paid tier is bought, change
// the env vars, not this file.
//
//   free   20,000 calls/month,   100 standard calls/min  (pro tools 1,000/hr)
//   paid    5,000 std calls/min; plan tiers $29/200K and $229/2M per month
//
// Every value is read at call time rather than module load so a Cloud Run env
// change takes effect on the next revision without a code edit, and so tests
// can set them per-case.

/** Org-wide monthly tool-call ceiling. */
export function orgMonthlyQuota(): number {
  return positiveInt(process.env.COMPOSIO_ORG_MONTHLY_QUOTA, 20_000);
}

/** Org-wide per-minute ceiling for standard tools. */
export function orgPerMinuteLimit(): number {
  return positiveInt(process.env.COMPOSIO_ORG_PER_MINUTE_LIMIT, 100);
}

/** Monthly calls held back for foreground work. Background work — a scheduled
 *  run at 3am, a connector event, anything with nobody waiting — may never
 *  spend into this. Default 10% of the free-tier month. */
export function reservedHeadroom(): number {
  return nonNegativeInt(process.env.COMPOSIO_MONTHLY_RESERVED_HEADROOM, 2_000);
}

/** Fraction of the spendable monthly quota (i.e. quota minus reserve) carved
 *  into per-tenant GUARANTEED slices. The remainder is the shared burst pool.
 *
 *  At 0.5 a tenant is guaranteed its fair half-share and may then compete for
 *  the other half. Setting this to 1.0 gives hard per-tenant partitioning with
 *  no bursting; at 0.0 every call competes for one shared pool. */
export function guaranteedFraction(): number {
  const raw = process.env.COMPOSIO_GUARANTEED_FRACTION;
  if (raw === undefined || raw === '') return 0.5;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0 || n > 1) return 0.5;
  return n;
}

/** Floor on a tenant's per-minute share, so a large fleet does not divide the
 *  org ceiling down to a rate no single agent turn can complete under. Capped
 *  by the org ceiling at the point of use — a floor must never raise a tenant
 *  above the whole organization's limit. */
export function minTenantPerMinute(): number {
  return positiveInt(process.env.COMPOSIO_MIN_TENANT_PER_MINUTE, 10);
}

/** How long a runtime may serve a cached allocation before refreshing. The
 *  monthly counter this bounds moves slowly; five minutes keeps the control
 *  plane off the hot path while keeping cross-pod drift small. */
export function allocationTtlMs(): number {
  return positiveInt(process.env.COMPOSIO_ALLOCATION_TTL_MS, 5 * 60 * 1000);
}

function positiveInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function nonNegativeInt(raw: string | undefined, fallback: number): number {
  const n = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}
