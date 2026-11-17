// Execution Guard
//
// checkExecutionAllowed(tenantId) is called at agent invocation start to block
// tenants that are not authorized to execute agents or whose account is suspended.
//
// Design rules:
//   - Gate on entitlements.agent_execution_allowed, not on billing_controls.has_payment_method.
//     has_payment_method is a Stripe card-on-file flag; agent_execution_allowed is the
//     canonical "this tenant is cleared to run agents" flag — set by subscription activation
//     and by the EXEMPT_TENANT_IDS path in tenant activate().
//   - billing_controls.suspended is the hard stop (overdue balance); it blocks even
//     exempt tenants.
//   - billing_controls is LEFT JOINed — internal/exempt accounts have no row there
//     and must not be blocked by its absence.
//   - In-flight deduplication: concurrent calls for the same tenantId share one DB read.
//     The promise is cleared immediately on resolution, so the next sequential invocation
//     always triggers a fresh read. This gives always-accurate results with at most
//     1 DB round-trip per concurrent burst.
//   - No TTL cache: state changes take effect on the very next invocation with no stale window.
//   - invalidateExecutionCache() is kept as a no-op for interface compatibility.

import { withTenantScope } from '../infrastructure/database';
import { PAST_ALLOWANCE_SQL, accountFloorUsd, prepaidSpendFloorUsd } from './prepaid-floor';
import { log } from '../infrastructure/logging';

type GuardResult = { allowed: boolean; reason?: string };

// Shown wherever a refusal is surfaced to the person (the launch gate reads
// the 402's message). Worded apart from the money refusals on purpose: a hold
// is not something buying more credit or a plan would lift, so it must not
// send anyone to the pricing page.
export const FRAUD_HOLD_REASON =
  'This workspace is on hold while a payment is reviewed. Please contact support to continue.';

// In-flight deduplication map. Entries exist only for the duration of an
// outstanding DB query — cleared immediately on resolution, never on a timer.
const inflight = new Map<string, Promise<GuardResult>>();

// No-op: kept for interface compatibility.
export function invalidateExecutionCache(_tenantId: string): void {}

export async function checkExecutionAllowed(tenantId: string): Promise<GuardResult> {
  const existing = inflight.get(tenantId);
  if (existing) return existing;

  // A pool that cannot be reached throws before any promise exists; that is
  // the same failure the .catch below allows through, and it is treated the
  // same way rather than escaping as an exception to the caller.
  let scoped: Promise<{ rows: Array<Record<string, unknown>> }>;
  try {
    scoped = withTenantScope(tenantId, (client) => client.query<{
      agent_execution_allowed: boolean;
      suspended: boolean | null;
      outstanding_balance_usd: string | null;
      billing_mode: string | null;
      reload_balance_usd: string | null;
      in_reload_territory: boolean | null;
      auto_reload_enabled: boolean | null;
      auto_reload_threshold_usd: string | null;
      suspended_reason: string | null;
      fraud_hold_at: Date | null;
    }>(
      `SELECT e.agent_execution_allowed, bc.suspended, bc.outstanding_balance_usd,
              bc.billing_mode, bc.reload_balance_usd,
              (${PAST_ALLOWANCE_SQL}) AS in_reload_territory,
              bc.auto_reload_enabled, bc.auto_reload_threshold_usd,
              bc.suspended_reason, bc.fraud_hold_at
       FROM entitlements e
       JOIN tenants t ON t.id = e.tenant_id
       LEFT JOIN billing_controls bc ON bc.account_id = t.account_id
       WHERE e.tenant_id = $1`,
      [tenantId],
    )) as Promise<{ rows: Array<Record<string, unknown>> }>;
  } catch (err) {
    log.error({ tenantId, error: (err as Error).message }, 'billing.execution_guard: DB unavailable — allowing through');
    return { allowed: true };
  }
  const query = scoped
    .then((result): GuardResult => {
      const row = result.rows[0] as {
        agent_execution_allowed: boolean;
        suspended: boolean | null;
        outstanding_balance_usd: string | null;
        billing_mode: string | null;
        reload_balance_usd: string | null;
        in_reload_territory: boolean | null;
        auto_reload_enabled: boolean | null;
        auto_reload_threshold_usd: string | null;
        suspended_reason: string | null;
        fraud_hold_at: Date | null;
      } | undefined;

      // A hold is not a money state. It is placed when the issuer of a card
      // that paid this account reports the payment as fraud, and no payment
      // lifts it — only an operator who has looked at the charge. Checked
      // before the plan and balance branches so a funded, subscribed
      // workspace is still refused, and so the person is not told to buy
      // something that would not help. The same column is a term in
      // prepaid-floor.billingStoppedSql, which is how the runtime's own gates
      // refuse the workspace from its entitlement snapshot.
      if (row?.fraud_hold_at) {
        return { allowed: false, reason: FRAUD_HOLD_REASON };
      }
      if (!row || !row.agent_execution_allowed) {
        return { allowed: false, reason: 'This workspace needs an active plan before agents can run. Please subscribe to a plan to continue.' };
      }
      if (row.suspended) {
        if (row.billing_mode === 'pre_pay') {
          const msg = row.suspended_reason === 'zero_prepaid_balance'
            ? 'Your credit balance is $0. Please add credit to continue.'
            : row.suspended_reason === 'auto_reload_failed'
              ? 'Your auto-reload was unsuccessful. Please update your payment method and try again.'
              : 'Your workspace is out of credit. Please add credit to continue.';
          return { allowed: false, reason: msg };
        }
        const balance = parseFloat(row.outstanding_balance_usd ?? '0').toFixed(2);
        return { allowed: false, reason: `Workspace has an outstanding balance of $${balance}. Please update your payment method.` };
      }
      // The prepaid floor (billing/prepaid-floor.ts): past the plan's
      // allowance, every charge drains the reload balance, and spend reaches
      // that balance minutes after it happened. A workspace admitted on the
      // last cent spends the platform's money for those minutes, so admission
      // stops under the floor, not at zero (at an auto-reload threshold
      // below the floor, see accountFloorUsd). A tenant still inside its
      // allowance runs regardless of the balance — that consumption is
      // bucket-rated to $0 customer cost and never drains.
      if (row.billing_mode === 'pre_pay'
        && row.in_reload_territory
        && parseFloat(row.reload_balance_usd ?? '0') < accountFloorUsd(prepaidSpendFloorUsd(), {
          enabled: row.auto_reload_enabled,
          thresholdUsd: row.auto_reload_threshold_usd,
        })) {
        return { allowed: false, reason: 'Your credit balance is too low to continue. Please add credit to continue.' };
      }
      return { allowed: true };
    })
    .catch((err: Error): GuardResult => {
      log.error({ tenantId, error: err.message }, 'billing.execution_guard: DB read failed — allowing through');
      return { allowed: true };
    })
    .finally(() => {
      inflight.delete(tenantId);
    });

  inflight.set(tenantId, query);
  return query;
}
