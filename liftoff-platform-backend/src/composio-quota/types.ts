// Composio quota governance — wire shape.
//
// Composio bills ONE ORGANIZATION-WIDE meter covering the whole platform —
// every tenant, every agent, every endpoint — in two dimensions:
//
//   * 100 standard tool calls / minute   (free tier; 1,000/hr for pro tools)
//   * 20,000 tool calls / month          (free tier)
//
// The tenant runtime is deployed PER TENANT with its own database and cannot
// see any other tenant's consumption, so an org-wide meter cannot live there.
// The control plane already does cross-tenant accounting for billing and OU
// metering, and every Composio dispatch already reports itself here
// (`reportComposioToolCall` -> POST /api/internal/platform-tools/composio-tool-
// calls -> cost_attribution_events with source='composio_mcp'). That ledger IS
// the org meter; this module reads it and hands each runtime a slice.
//
// The runtime caches an allocation and enforces LOCALLY against it, so no
// connector tool call ever waits on the control plane.

/** One tenant's view of the org-wide Composio budget. Computed by the control
 *  plane, cached and enforced by that tenant's runtime. */
export interface ComposioQuotaAllocation {
  /** Org-wide monthly ceiling (all tenants share this single number). */
  orgMonthlyQuota: number;
  /** Org-wide calls recorded so far in the current calendar month (UTC). */
  orgConsumed: number;
  /** `orgMonthlyQuota - orgConsumed`, floored at 0. */
  orgRemaining: number;

  /** Slice of the monthly quota reserved for foreground work. Background work
   *  (scheduled runs, connector events — nobody is waiting) may never spend
   *  into this. A person asking for something still can. */
  reservedHeadroom: number;
  /** False once `orgRemaining <= reservedHeadroom`: background work stops,
   *  foreground work continues into the reserve. */
  backgroundAllowed: boolean;

  /** This tenant's GUARANTEED monthly allowance. Spending inside it never
   *  depends on what other tenants did. */
  tenantMonthlySlice: number;
  /** This tenant's calls recorded so far in the current calendar month. */
  tenantConsumed: number;
  /** `tenantMonthlySlice - tenantConsumed`, floored at 0. */
  tenantRemaining: number;

  /** Unallocated remainder of the monthly quota, shared by every tenant on a
   *  first-come basis once a tenant has spent its guaranteed slice. */
  burstPool: number;

  /** This tenant's share of the org's per-minute ceiling. NEVER greater than
   *  the org ceiling itself — no single tenant may be authorised to exceed
   *  what the whole organization is allowed. */
  perMinuteLimit: number;
  /** The org's own per-minute ceiling, carried so the runtime can log the
   *  relationship rather than re-deriving it. */
  orgPerMinuteLimit: number;

  /** Number of provisioned tenants the slice was divided between. */
  tenantCount: number;

  /** Start of the current monthly window (UTC), ISO-8601. */
  periodStart: string;
  /** Start of the NEXT monthly window (UTC), ISO-8601 — when consumption
   *  resets to zero. */
  periodEnd: string;

  /** How long the runtime may serve this allocation from cache before
   *  refreshing. */
  refreshAfterMs: number;
}

/** Why a Composio call was refused. Carried into the tool error so an operator
 *  reads a platform decision rather than an unexplained vendor 429. */
export type ComposioQuotaDenialReason =
  /** Per-minute token bucket for this tenant is empty. */
  | 'tenant_rate_limited'
  /** The org's whole monthly allowance is gone. Nothing runs until the window
   *  rolls. */
  | 'org_monthly_quota_exhausted'
  /** Only the foreground reserve is left, and this call is background work. */
  | 'background_reserve_protected'
  /** This tenant is past its guaranteed slice and the shared burst pool is
   *  down to the foreground reserve. */
  | 'tenant_monthly_slice_exhausted';
