// PR 3 / Gap A — consolidated read of all state relevant to an enterprise
// account: accounts, tenants (+ per-tenant role from tenant_members),
// entitlements, billing_controls, the active enterprise_contract,
// platform-backend's local subscriptions mirror, plus Stripe-side state
// (the current active sub on the canonical customer, and any "orphan" subs
// — active subs tagged with this tenant's id but on a different customer).
//
// Used by:
//   - GET /api/admin/accounts/:accountId/state (handler in this PR).
//   - POST /api/admin/accounts/:accountId/enterprise-setup pre + post snapshots
//     (PR 5 — depends on this service).
//
// `inferHealthIssues(snapshot)` walks the snapshot and returns a curated list
// of inconsistencies that have caused real provisioning incidents. It is NOT
// a comprehensive linter — see docs/admin-api.md for the explicit scope.
//
// Stripe rate-limiting on the orphan-sub search degrades gracefully: the
// snapshot returns with `stripe.searchAvailable = false` and inferHealthIssues
// surfaces 'stripe_search_unavailable' rather than throwing.

import Stripe from 'stripe';
import type { Pool } from 'pg';
import { getPool, withAdminScope } from '../infrastructure/database';
import { getStripeSecretKey } from '../infrastructure/secrets';
import { log } from '../infrastructure/logging';
import { AccountNotFoundError } from '../accounts/service';

let _stripe: Stripe | null = null;
async function getStripe(): Promise<Stripe> {
  if (!_stripe) _stripe = new Stripe(await getStripeSecretKey());
  return _stripe;
}

// ── Types ─────────────────────────────────────────────────────────────────

export interface AccountStateAccount {
  id: string;
  email: string;
  stripeCustomerId: string | null;
  isPlatformAdmin: boolean;
}

export interface AccountStateTenant {
  id: string;
  name: string;
  status: string;
  gcpProjectId: string | null;
  databaseName: string | null;
  role: string | null; // from tenant_members JOIN; null if the account isn't a member
  createdAt: string;
}

export interface AccountStateEntitlement {
  tenantId: string;
  tenantOperationalStatus: string;
  agentExecutionAllowed: boolean;
  remainingIncludedCredits: number;
  overageAllowed: boolean;
}

export interface AccountStateBillingControls {
  accountId: string;
  billingTier: 'standard' | 'enterprise';
  stripeCustomerId: string | null;
  stripeSubscriptionId: string | null;
  suspended: boolean;
  suspendedReason: string | null;
  currentPeriodSpendUsd: string;
  prepaidBalanceUsd: string;
  updatedAt: string;
}

export interface AccountStateContract {
  accountId: string;
  includedOus: string;
  precommitExtraOus: string;
  includedRateUsdPerOu: string;
  precommitRateUsdPerOu: string;
  reloadRateUsdPerOu: string;
  stripeBilled: boolean;
  isAnnualPlan: boolean;
  annualTotalUsdCents: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  contractReference: string | null;
}

export interface AccountStateLocalSubscription {
  id: string;
  planId: string;
  stripeSubscriptionId: string | null;
  status: string;
  currentPeriodStart: string | null;
  currentPeriodEnd: string | null;
  updatedAt: string;
}

export interface AccountStateStripeSub {
  id: string;
  status: Stripe.Subscription.Status;
  customer: string;
  metadata: Record<string, string>;
}

export interface AccountStateSnapshot {
  account: AccountStateAccount;
  tenants: AccountStateTenant[];
  entitlements: AccountStateEntitlement[];
  billingControls: AccountStateBillingControls | null;
  contract: AccountStateContract | null;
  subscriptions: AccountStateLocalSubscription[];
  stripe: {
    activeSubscription: AccountStateStripeSub | null;
    // Full status='all' list result keyed on the canonical Stripe customer.
    // Needed so inferHealthIssues can distinguish "sub exists in Stripe but
    // is canceled" from "sub deleted (resource_missing)" — see P3-D.
    allSubscriptions: AccountStateStripeSub[];
    orphanSubscriptions: AccountStateStripeSub[];
    searchAvailable: boolean;
  };
}

export interface ReadAccountStateDeps {
  stripe?: Stripe;
  pool?: Pool;
}

// ── readAccountState ──────────────────────────────────────────────────────

export async function readAccountState(
  accountId: string,
  deps: ReadAccountStateDeps = {},
): Promise<AccountStateSnapshot> {
  const pool = deps.pool ?? getPool();

  // Phase 1: 6 independent DB lookups in parallel.
  const [
    accountRes,
    tenantsRes,
    entitlementsRes,
    billingControlsRes,
    contractRes,
    subsRes,
  ] = await Promise.all([
    pool.query<{
      id: string;
      email: string;
      stripe_customer_id: string | null;
      is_platform_admin: boolean;
    }>(
      `SELECT id, email, stripe_customer_id, is_platform_admin
         FROM accounts
        WHERE id = $1`,
      [accountId],
    ),
    // tenant_members is RLS-enabled; this operator account-state read spans
    // every tenant under the account with no single tenant scope → withAdminScope.
    withAdminScope(
      { caller: 'admin.account-state.tenants', reason: 'operator cross-tenant account-state read (tenant_members JOIN, no single tenant scope)' },
      (client) => client.query<{
        id: string;
        name: string;
        status: string;
        gcp_project_id: string | null;
        database_name: string | null;
        created_at: Date;
        role: string | null;
      }>(
        // Per Q1: tenant role lives on tenant_members. JOIN to surface the
        // requesting account's per-tenant role. Primary tenant = earliest
        // created_at.
        `SELECT t.id, t.name, t.status, t.gcp_project_id, t.database_name, t.created_at,
                tm.role::text AS role
           FROM tenants t
           LEFT JOIN tenant_members tm
             ON tm.tenant_id = t.id AND tm.account_id = t.account_id
          WHERE t.account_id = $1
          ORDER BY t.created_at ASC`,
        [accountId],
      ),
    ),
    // entitlements is RLS-enabled; same operator cross-tenant context → withAdminScope.
    withAdminScope(
      { caller: 'admin.account-state.entitlements', reason: 'operator cross-tenant account-state read (entitlements across the account, no single tenant scope)' },
      (client) => client.query<{
        tenant_id: string;
        tenant_operational_status: string;
        agent_execution_allowed: boolean;
        remaining_included_credits: number;
        overage_allowed: boolean;
      }>(
        `SELECT e.tenant_id, e.tenant_operational_status, e.agent_execution_allowed,
                e.remaining_included_credits, e.overage_allowed
           FROM entitlements e
           JOIN tenants t ON t.id = e.tenant_id
          WHERE t.account_id = $1`,
        [accountId],
      ),
    ),
    pool.query<{
      account_id: string;
      billing_tier: 'standard' | 'enterprise';
      stripe_customer_id: string | null;
      stripe_subscription_id: string | null;
      suspended: boolean;
      suspended_reason: string | null;
      current_period_spend_usd: string;
      reload_balance_usd: string;
      updated_at: Date;
    }>(
      `SELECT account_id, billing_tier, stripe_customer_id, stripe_subscription_id,
              suspended, suspended_reason, current_period_spend_usd,
              reload_balance_usd, updated_at
         FROM billing_controls
        WHERE account_id = $1`,
      [accountId],
    ),
    pool.query<{
      account_id: string;
      included_ous: string;
      precommit_extra_ous: string;
      included_rate_usd_per_ou: string;
      precommit_rate_usd_per_ou: string;
      reload_rate_usd_per_ou: string;
      stripe_billed: boolean;
      is_annual_plan: boolean;
      annual_total_usd_cents: string | null;
      effective_from: Date;
      effective_to: Date | null;
      contract_reference: string | null;
    }>(
      // Active contract: effective_to is null or in the future.
      `SELECT account_id, included_ous, precommit_extra_ous,
              included_rate_usd_per_ou, precommit_rate_usd_per_ou, reload_rate_usd_per_ou,
              stripe_billed, is_annual_plan, annual_total_usd_cents,
              effective_from, effective_to, contract_reference
         FROM enterprise_contracts
        WHERE account_id = $1
          AND (effective_to IS NULL OR effective_to > NOW())
        ORDER BY effective_from DESC
        LIMIT 1`,
      [accountId],
    ),
    pool.query<{
      id: string;
      plan_id: string;
      stripe_subscription_id: string | null;
      status: string;
      current_period_start: Date | null;
      current_period_end: Date | null;
      updated_at: Date;
    }>(
      // Active subs + last 5 canceled (the plan's "active + last 5 canceled,
      // ordered by updated_at DESC"). UNION ALL keeps the ordering rules
      // distinct: all active rows first, then the most-recent canceled rows.
      `(
         SELECT id, plan_id, stripe_subscription_id, status,
                current_period_start, current_period_end, updated_at
           FROM subscriptions
          WHERE account_id = $1 AND status = 'active'
          ORDER BY updated_at DESC
       )
       UNION ALL
       (
         SELECT id, plan_id, stripe_subscription_id, status,
                current_period_start, current_period_end, updated_at
           FROM subscriptions
          WHERE account_id = $1 AND status != 'active'
          ORDER BY updated_at DESC
          LIMIT 5
       )`,
      [accountId],
    ),
  ]);

  if (!accountRes.rows[0]) {
    throw new AccountNotFoundError(accountId);
  }

  const accountRow = accountRes.rows[0];
  const tenants: AccountStateTenant[] = tenantsRes.rows.map((r) => ({
    id: r.id,
    name: r.name,
    status: r.status,
    gcpProjectId: r.gcp_project_id,
    databaseName: r.database_name,
    role: r.role,
    createdAt: r.created_at.toISOString(),
  }));
  const entitlements: AccountStateEntitlement[] = entitlementsRes.rows.map((r) => ({
    tenantId: r.tenant_id,
    tenantOperationalStatus: r.tenant_operational_status,
    agentExecutionAllowed: r.agent_execution_allowed,
    remainingIncludedCredits: r.remaining_included_credits,
    overageAllowed: r.overage_allowed,
  }));
  const bcRow = billingControlsRes.rows[0] ?? null;
  const billingControls: AccountStateBillingControls | null = bcRow
    ? {
        accountId: bcRow.account_id,
        billingTier: bcRow.billing_tier,
        stripeCustomerId: bcRow.stripe_customer_id,
        stripeSubscriptionId: bcRow.stripe_subscription_id,
        suspended: bcRow.suspended,
        suspendedReason: bcRow.suspended_reason,
        currentPeriodSpendUsd: bcRow.current_period_spend_usd,
        prepaidBalanceUsd: bcRow.reload_balance_usd,
        updatedAt: bcRow.updated_at.toISOString(),
      }
    : null;
  const contractRow = contractRes.rows[0] ?? null;
  const contract: AccountStateContract | null = contractRow
    ? {
        accountId: contractRow.account_id,
        includedOus: contractRow.included_ous,
        precommitExtraOus: contractRow.precommit_extra_ous,
        includedRateUsdPerOu: contractRow.included_rate_usd_per_ou,
        precommitRateUsdPerOu: contractRow.precommit_rate_usd_per_ou,
        reloadRateUsdPerOu: contractRow.reload_rate_usd_per_ou,
        stripeBilled: contractRow.stripe_billed,
        isAnnualPlan: contractRow.is_annual_plan,
        annualTotalUsdCents: contractRow.annual_total_usd_cents,
        effectiveFrom: contractRow.effective_from.toISOString(),
        effectiveTo: contractRow.effective_to ? contractRow.effective_to.toISOString() : null,
        contractReference: contractRow.contract_reference,
      }
    : null;
  const subscriptions: AccountStateLocalSubscription[] = subsRes.rows.map((r) => ({
    id: r.id,
    planId: r.plan_id,
    stripeSubscriptionId: r.stripe_subscription_id,
    status: r.status,
    currentPeriodStart: r.current_period_start ? r.current_period_start.toISOString() : null,
    currentPeriodEnd: r.current_period_end ? r.current_period_end.toISOString() : null,
    updatedAt: r.updated_at.toISOString(),
  }));

  // Phase 2: Stripe-side lookups. Need stripe_customer_id (from accounts;
  // fall back to billing_controls) and primary tenant id.
  const stripeCustomerId =
    accountRow.stripe_customer_id ?? billingControls?.stripeCustomerId ?? null;
  const primaryTenantId = tenants[0]?.id ?? null;

  let stripeActive: AccountStateStripeSub | null = null;
  let allSubscriptions: AccountStateStripeSub[] = [];
  let orphanSubscriptions: AccountStateStripeSub[] = [];
  let searchAvailable = true;

  if (stripeCustomerId) {
    const stripe = deps.stripe ?? (await getStripe());

    // Stripe `.list()` failures propagate (P3-B): the plan only authorizes
    // graceful degradation for the SEARCH path. A list-call failure means the
    // operator is seeing a snapshot with no Stripe-side view at all — that's
    // a 500-worthy condition, not something to silently surface as
    // "activeSubscription: null".
    const customerSubs = await stripe.subscriptions.list({
      customer: stripeCustomerId,
      limit: 10,
      status: 'all',
    });
    allSubscriptions = customerSubs.data.map((s) => ({
      id: s.id,
      status: s.status,
      customer: typeof s.customer === 'string' ? s.customer : s.customer.id,
      metadata: s.metadata ?? {},
    }));
    const active = customerSubs.data.find(
      (s) => s.status === 'active' || s.status === 'trialing',
    );
    if (active) {
      stripeActive = {
        id: active.id,
        status: active.status,
        customer: typeof active.customer === 'string' ? active.customer : active.customer.id,
        metadata: active.metadata ?? {},
      };
    }

    if (primaryTenantId) {
      try {
        // Per Q2: subscriptions.search is supported by the pinned Stripe SDK.
        // Orphan = sub tagged with our tenant_id but on a different customer.
        //
        // Stripe Search does NOT support mixing AND with OR in a single query
        // ("Queries cannot have a mix of AND and OR"). We fan out into one
        // search per status and union the results — same semantics, valid
        // syntax. limit:20 per status caps at 40 orphans total which is
        // well beyond the 0–2 we expect in practice.
        const [activeRes, trialingRes] = await Promise.all([
          stripe.subscriptions.search({
            query: `metadata['tenant_id']:'${primaryTenantId}' AND status:'active'`,
            limit: 20,
          }),
          stripe.subscriptions.search({
            query: `metadata['tenant_id']:'${primaryTenantId}' AND status:'trialing'`,
            limit: 20,
          }),
        ]);
        const seen = new Set<string>();
        orphanSubscriptions = [...activeRes.data, ...trialingRes.data]
          .filter((s) => {
            if (seen.has(s.id)) return false;
            seen.add(s.id);
            const cust = typeof s.customer === 'string' ? s.customer : s.customer.id;
            return cust !== stripeCustomerId;
          })
          .map((s) => ({
            id: s.id,
            status: s.status,
            customer: typeof s.customer === 'string' ? s.customer : s.customer.id,
            metadata: s.metadata ?? {},
          }));
      } catch (err) {
        // P3-A — narrow catch to rate-limit only per the plan's explicit
        // wording. Other search errors propagate so they surface to ops
        // rather than silently masquerading as "no orphans".
        if (err instanceof Stripe.errors.StripeRateLimitError) {
          searchAvailable = false;
          log.warn(
            { err, accountId, primaryTenantId },
            'admin.account_state.stripe_search_rate_limited',
          );
        } else {
          throw err;
        }
      }
    }
  }

  return {
    account: {
      id: accountRow.id,
      email: accountRow.email,
      stripeCustomerId: accountRow.stripe_customer_id,
      isPlatformAdmin: accountRow.is_platform_admin,
    },
    tenants,
    entitlements,
    billingControls,
    contract,
    subscriptions,
    stripe: {
      activeSubscription: stripeActive,
      allSubscriptions,
      orphanSubscriptions,
      searchAvailable,
    },
  };
}

// ── inferHealthIssues ─────────────────────────────────────────────────────

// Curated list of inconsistencies that have caused real provisioning failures.
// NOT a comprehensive linter — see docs/admin-api.md for the explicit scope.
export function inferHealthIssues(snapshot: AccountStateSnapshot): string[] {
  const issues: string[] = [];

  const bc = snapshot.billingControls;
  const active = snapshot.stripe.activeSubscription;

  // Stripe active sub's customer differs from billing_controls.stripe_customer_id.
  if (active && bc?.stripeCustomerId && active.customer !== bc.stripeCustomerId) {
    issues.push('stripe_active_sub_customer_mismatch');
  }

  // Local `subscriptions` row with status='active' but the Stripe-side active
  // sub is canceled or missing entirely. We can detect the missing case by
  // comparing local stripe_subscription_id against the live active sub.
  const localActive = snapshot.subscriptions.find((s) => s.status === 'active');
  if (localActive?.stripeSubscriptionId) {
    if (!active || active.id !== localActive.stripeSubscriptionId) {
      issues.push('local_active_sub_diverged_from_stripe');
    }
  }

  // billing_controls.stripe_subscription_id non-null but Stripe sub returns
  // resource_missing — distinguished from "canceled but exists" by matching
  // against the FULL list(status='all') result, not just the active sub.
  if (bc?.stripeSubscriptionId) {
    const stripeKnowsThisSub =
      snapshot.stripe.allSubscriptions.some((s) => s.id === bc.stripeSubscriptionId) ||
      // Also accept if the orphan list mentions it — it exists, just on
      // another customer (caught by stripe_active_sub_customer_mismatch or
      // stripe_orphan_subscriptions_present).
      snapshot.stripe.orphanSubscriptions.some((s) => s.id === bc.stripeSubscriptionId);
    if (!stripeKnowsThisSub) {
      issues.push('billing_controls_subscription_missing_from_stripe');
    }
  }

  // enterprise_contracts row exists but billing_controls.billing_tier !== 'enterprise'.
  if (snapshot.contract && bc && bc.billingTier !== 'enterprise') {
    issues.push('contract_present_but_tier_not_enterprise');
  }

  // Orphan Stripe subs (= subs tagged with this tenant_id on a different customer).
  if (snapshot.stripe.orphanSubscriptions.length > 0) {
    issues.push('stripe_orphan_subscriptions_present');
  }

  // billing_controls.suspended=true while an active Stripe sub exists.
  if (bc?.suspended && active) {
    issues.push('billing_controls_suspended_but_stripe_active');
  }

  // Degradation surfacing from the rate-limit / search failure path.
  if (!snapshot.stripe.searchAvailable) {
    issues.push('stripe_search_unavailable');
  }

  return issues;
}
