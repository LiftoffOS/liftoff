// The auto-reload sweep: fires the reload for a workspace the drain can no
// longer reach.
//
// The drain fires a reload when a charge takes the balance to the threshold,
// at most once per cooldown (AUTO_RELOAD_COOLDOWN_MS). A workspace that spends
// a whole reload inside the cooldown comes back under its threshold with no
// claim, stops at its floor (prepaid-floor.accountFloorUsd), and then makes no
// further charges, so no drain reaches it again. A $1 threshold with a $5
// reload makes that ordinary. This sweep reaches it.
//
// It claims exactly what the drain would have claimed: pre-pay, auto-reload on
// with an amount and a customer, past the plan's allowance, at or under the
// threshold, cooldown elapsed. Left out: a declined card (auto_reload_failed,
// retried when a card is attached, never by a timer), a fraud hold, and every
// other suspension. A zero_prepaid_balance suspension is included; it is the
// same stuck workspace one charge later.
//
// The claim is the cooldown stamp the drain writes, taken under FOR UPDATE
// SKIP LOCKED, so instances running this together, or against the drain,
// charge an account once.

import type { PoolClient } from 'pg';
import { withAdminScope } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { PAST_ALLOWANCE_SQL } from './prepaid-floor';
import { AUTO_RELOAD_COOLDOWN_MS, fireAutoReloadClaim } from '../cost-attribution/reload-drain';

const BATCH_LIMIT = 100;

interface ClaimedRow {
  account_id: string;
  stripe_customer_id: string;
  auto_reload_amount_usd: string;
  tenant_id: string | null;
}

export async function claimStrandedAutoReloads(client: PoolClient): Promise<ClaimedRow[]> {
  const { rows } = await client.query<ClaimedRow>(
    `UPDATE billing_controls
        SET last_auto_reload_triggered_at = NOW()
      WHERE account_id IN (
        SELECT bc.account_id
          FROM billing_controls bc
         WHERE bc.billing_mode = 'pre_pay'
           AND bc.auto_reload_enabled
           AND bc.auto_reload_threshold_usd IS NOT NULL
           AND bc.auto_reload_amount_usd > 0
           AND bc.stripe_customer_id IS NOT NULL
           AND bc.fraud_hold_at IS NULL
           AND (NOT bc.suspended OR bc.suspended_reason = 'zero_prepaid_balance')
           AND ${PAST_ALLOWANCE_SQL}
           AND bc.reload_balance_usd <= bc.auto_reload_threshold_usd
           AND (bc.last_auto_reload_triggered_at IS NULL
                OR bc.last_auto_reload_triggered_at < NOW() - $1 * INTERVAL '1 millisecond')
         LIMIT $2
           FOR UPDATE SKIP LOCKED
      )
      RETURNING account_id, stripe_customer_id, auto_reload_amount_usd,
                (SELECT t.id FROM tenants t WHERE t.account_id = billing_controls.account_id
                  ORDER BY t.created_at ASC LIMIT 1) AS tenant_id`,
    [AUTO_RELOAD_COOLDOWN_MS, BATCH_LIMIT],
  );
  return rows;
}

/** One pass: claim, commit, then fire each claim. Returns how many fired. */
export async function runAutoReloadSweep(): Promise<number> {
  const claimed = await withAdminScope(
    { caller: 'billing.auto-reload-sweep', reason: 'find pre-pay accounts stopped under their auto-reload threshold (cross-tenant, no single tenant scope)' },
    claimStrandedAutoReloads,
  );
  for (const row of claimed) {
    fireAutoReloadClaim(
      { stripeCustomerId: row.stripe_customer_id, autoReloadAmountUsd: row.auto_reload_amount_usd },
      row.account_id,
      row.tenant_id,
      'billing.auto_reload_sweep',
    );
  }
  if (claimed.length > 0) log.info({ fired: claimed.length }, 'billing.auto_reload_sweep: fired stranded reloads');
  return claimed.length;
}
