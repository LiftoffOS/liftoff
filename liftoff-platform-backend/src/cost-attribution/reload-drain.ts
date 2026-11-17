// Single source of truth for the reload-balance drain side-effect that fires
// whenever a customer-chargeable consumption event lands (partly or wholly)
// in the 'reload' bucket.
//
// Both spend-subscriber (real-time tenant_runtime path via Pub/Sub) and
// ingestEventWithBuckets (batched poll path for governance / developer_proxy
// / runtime / sandbox / customer-facing platform_llm) call this helper inside
// their tx so the drain commits atomically with the bucket assignment that
// produced it. This closes Loss A — previously only spend-subscriber drained,
// so any reload-bucket consumption from an ingester source was visible to the
// customer in /insights but never debited from their wallet, leaving Liftoff
// with the underlying compute cost and no offsetting collection.
//
// AUTO-RELOAD TRIGGER POLICY
//   Every caller takes the auto-reload claim and fires the Stripe invoice
//   post-commit (fireAutoReloadClaim), never inside its transaction. The drain
//   is the only automatic trigger: nothing sweeps for low balances later. So
//   the charge that takes the balance to the threshold must fire the reload,
//   whichever path booked it, because a workspace stopped at its floor makes
//   no further charges (billing/prepaid-floor.ts accountFloorUsd).

import type { PoolClient } from 'pg';
import { accountFloorUsd, prepaidSpendFloorUsd } from '../billing/prepaid-floor';
import { getBillingAdminClient } from '../billing/billing-admin-client';
import { log } from '../infrastructure/logging';
import type { BucketAssignment } from './ou-bucket-service';
import { notifyAgentsStalled } from './agents-stalled-notify';

/** At most one automatic reload per account in this window: the drain and
 *  billing/auto-reload-sweep.ts both claim through last_auto_reload_triggered_at. */
export const AUTO_RELOAD_COOLDOWN_MS = 5 * 60 * 1000;

export interface AutoReloadClaim {
  stripeCustomerId: string;
  autoReloadAmountUsd: string;
}

export interface DrainResult {
  reloadChargeUsd: number;
  /** This drain stopped the workspace's spending — it took the balance below
   *  zero and suspended the account, or below the prepaid floor at which the
   *  served snapshot reads as suspended (billing/prepaid-floor.ts). The caller
   *  publishes the change once its transaction has committed, so the runtime's
   *  gates refuse the next call in seconds rather than a minute. */
  suspendedNow: boolean;
  /** Why, when suspendedNow: the balance went negative, or under the floor. */
  stopReason: 'zero_prepaid_balance' | 'prepaid_floor' | null;
  /** Non-null when this charge took the balance to the auto-reload threshold
   *  and the caller opted in (fireAutoReload); the caller fires it post-commit
   *  with fireAutoReloadClaim. */
  autoReloadClaim: AutoReloadClaim | null;
}

/**
 * Deduct the reload-bucket portion of `assignments` from the tenant's
 * reload_balance_usd, suspend the account if the balance went negative,
 * and (for callers that opt in) prepare an auto-reload claim the caller
 * fires post-commit.
 *
 * Idempotent under the surrounding transaction's FOR UPDATE on
 * billing_controls (the caller acquired this lock via applyOuConsumption).
 */
export async function applyReloadDrain(
  client: PoolClient,
  accountId: string,
  assignments: BucketAssignment[],
  opts: { fireAutoReload: boolean },
): Promise<DrainResult> {
  const reloadChargeUsd = assignments
    .filter((a) => a.costBucket === 'reload')
    .reduce((s, a) => s + a.customerCostUsd, 0);
  if (reloadChargeUsd <= 0) {
    return { reloadChargeUsd: 0, suspendedNow: false, stopReason: null, autoReloadClaim: null };
  }

  // Drain only fires for pre_pay accounts. Read billing_mode within the
  // same tx as the drain so a concurrent mode change can't slip past; the
  // suspension flag beside it, so the flip below is a fact of this drain
  // and not of an earlier one.
  const modeRow = await client.query<{ billing_mode: string; suspended: boolean }>(
    `SELECT billing_mode, suspended FROM billing_controls WHERE account_id = $1`,
    [accountId],
  );
  if (modeRow.rows[0]?.billing_mode !== 'pre_pay') {
    return { reloadChargeUsd: 0, suspendedNow: false, stopReason: null, autoReloadClaim: null };
  }
  const suspendedBefore = modeRow.rows[0].suspended === true;

  const deductRes = await client.query<{
    reload_balance_usd: string;
    suspended: boolean;
    auto_reload_enabled: boolean;
    auto_reload_threshold_usd: string | null;
    auto_reload_amount_usd: string | null;
    last_auto_reload_triggered_at: Date | null;
    stripe_customer_id: string | null;
    agents_stalled_notified_at: Date | null;
    billing_period_start: Date | null;
  }>(
    `UPDATE billing_controls SET
       reload_balance_usd = reload_balance_usd - $2,
       suspended          = CASE WHEN reload_balance_usd - $2 < 0 THEN TRUE ELSE suspended END,
       suspended_reason   = CASE WHEN reload_balance_usd - $2 < 0 THEN 'zero_prepaid_balance' ELSE suspended_reason END,
       updated_at         = NOW()
     WHERE account_id = $1
     RETURNING reload_balance_usd, suspended, auto_reload_enabled,
               auto_reload_threshold_usd, auto_reload_amount_usd,
               last_auto_reload_triggered_at, stripe_customer_id,
               agents_stalled_notified_at, billing_period_start`,
    [accountId, reloadChargeUsd],
  );

  // Zero-crossing detection: if balance went to <=0 and auto-reload is OFF
  // and we have not already notified for this depletion cycle, mark notified
  // and fire the agents-stalled email. Single-process call — no HTTP hop.
  const arRow = deductRes.rows[0];
  // The crossing this charge caused, if any. Below zero the row itself is
  // suspended; below the floor the served snapshot reads as suspended
  // (billing/prepaid-floor.ts) — both are published by the caller so the
  // runtime does not wait for its next refresh. The floor crossing is read
  // off the balance before and after this charge, and only for an account
  // that was spending: one already stopped has nothing new to hear.
  const balanceAfter = arRow ? parseFloat(arRow.reload_balance_usd) : NaN;
  const balanceBefore = balanceAfter + reloadChargeUsd;
  const floor = arRow
    ? accountFloorUsd(prepaidSpendFloorUsd(), {
        enabled: arRow.auto_reload_enabled,
        thresholdUsd: arRow.auto_reload_threshold_usd,
      })
    : prepaidSpendFloorUsd();
  const crossedZero = !suspendedBefore && arRow?.suspended === true;
  const crossedFloor = !suspendedBefore && !crossedZero && Number.isFinite(balanceAfter)
    && balanceBefore >= floor && balanceAfter < floor;
  const suspendedNow = crossedZero || crossedFloor;
  const stopReason: DrainResult['stopReason'] = crossedZero ? 'zero_prepaid_balance' : crossedFloor ? 'prepaid_floor' : null;
  if (
    arRow &&
    parseFloat(arRow.reload_balance_usd) <= 0 &&
    !arRow.auto_reload_enabled &&
    arRow.agents_stalled_notified_at === null
  ) {
    await client.query(
      `UPDATE billing_controls SET agents_stalled_notified_at = NOW() WHERE account_id = $1`,
      [accountId],
    );
    // OUs reset 1 month from the current billing_period_start (annual plans
    // still grant OUs monthly). Inline JS Date math — no date-fns installed.
    const nextResetDate = arRow.billing_period_start ? new Date(arRow.billing_period_start) : new Date();
    nextResetDate.setMonth(nextResetDate.getMonth() + 1);
    void notifyAgentsStalled(accountId, { nextResetDate });
  }

  if (!opts.fireAutoReload) {
    return { reloadChargeUsd, suspendedNow, stopReason, autoReloadClaim: null };
  }

  const ar = deductRes.rows[0];
  if (!ar?.auto_reload_enabled || ar.auto_reload_threshold_usd == null) {
    return { reloadChargeUsd, suspendedNow, stopReason, autoReloadClaim: null };
  }
  const balanceFloat = parseFloat(ar.reload_balance_usd);
  const thresholdFloat = parseFloat(ar.auto_reload_threshold_usd);
  if (!(balanceFloat <= thresholdFloat)) {
    return { reloadChargeUsd, suspendedNow, stopReason, autoReloadClaim: null };
  }
  // 5-minute cooldown so a flurry of reload-bucket events doesn't fire many
  // overlapping auto-reload Stripe invoices.
  const triggeredAt = ar.last_auto_reload_triggered_at?.getTime() ?? 0;
  if (triggeredAt > 0 && Date.now() - triggeredAt <= AUTO_RELOAD_COOLDOWN_MS) {
    return { reloadChargeUsd, suspendedNow, stopReason, autoReloadClaim: null };
  }
  await client.query(
    `UPDATE billing_controls SET last_auto_reload_triggered_at = NOW() WHERE account_id = $1`,
    [accountId],
  );
  if (!ar.stripe_customer_id || !ar.auto_reload_amount_usd) {
    return { reloadChargeUsd, suspendedNow, stopReason, autoReloadClaim: null };
  }
  return {
    reloadChargeUsd,
    suspendedNow,
    stopReason,
    autoReloadClaim: {
      stripeCustomerId: ar.stripe_customer_id,
      autoReloadAmountUsd: ar.auto_reload_amount_usd,
    },
  };
}

/** Reload calls still in flight, so the request that started them can wait. */
const pendingReloads = new Set<Promise<void>>();

/** Fire a claim from applyReloadDrain, after the caller's transaction has
 *  committed. The caller does not wait: a failed charge reaches
 *  /auto-reload-failed from liftoff-billing, and a failed call here is only
 *  logged. The request that started it does, through settlePendingAutoReloads:
 *  this service runs on request-based CPU, and a call still in flight when its
 *  request answers stalls until some later request arrives. */
export function fireAutoReloadClaim(
  claim: AutoReloadClaim,
  accountId: string,
  tenantId: string | null,
  caller: string,
): void {
  const amount = parseFloat(claim.autoReloadAmountUsd);
  const call = getBillingAdminClient().triggerAutoReload(claim.stripeCustomerId, amount, tenantId).then(
    () => undefined,
    (err: Error) => {
      log.warn({ error: err.message, accountId, amount }, `${caller}: auto-reload trigger failed (non-fatal)`);
    },
  );
  pendingReloads.add(call);
  void call.finally(() => pendingReloads.delete(call));
}

/** Wait for every reload call fired so far. Never rejects. */
export async function settlePendingAutoReloads(): Promise<void> {
  while (pendingReloads.size > 0) await Promise.all([...pendingReloads]);
}
