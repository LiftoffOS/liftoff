// Billing startup invariant checks.
//
// Detects and auto-heals drift between billing_controls (the canonical
// enterprise/pre-pay state, owned by liftoff-billing's subscription-activated
// webhook handler) and the local `subscriptions` table that powers
// /api/subscriptions/account/:accountId/active. The two are now kept in sync
// by `mirrorSubscriptionActive` inside the subscription-activated handler;
// this boot-time pass backfills accounts whose mirror is missing — for example
// tenants provisioned via raw SQL, which bypasses the mirror.
//
// All writes are idempotent. The pass logs a warning per drifted account
// and inserts an `active` row with plan_id derived from billing_controls.
// If the query fails, we log and continue boot — never block startup on a
// diagnostic read.

import { getPool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

interface EnterpriseDriftRow {
  tenant_id: string;
  account_id: string;
  billing_mode: string | null;
  billing_tier: string | null;
  plan_type: string | null;
  stripe_subscription_id: string | null;
}

export async function logEnterpriseSubscriptionDrift(): Promise<void> {
  const pool = getPool();
  try {
    const result = await pool.query<EnterpriseDriftRow>(
      `SELECT t.id AS tenant_id, t.account_id, bc.billing_mode, bc.billing_tier,
              bc.plan_type, bc.stripe_subscription_id
       FROM billing_controls bc
       JOIN tenants t ON t.account_id = bc.account_id
       WHERE bc.billing_tier = 'enterprise'
         AND NOT EXISTS (
           SELECT 1 FROM subscriptions s
           WHERE s.account_id = bc.account_id AND s.status = 'active'
         )`,
    );
    if (result.rows.length === 0) return;
    for (const row of result.rows) {
      const planId = row.plan_type ?? (row.billing_tier === 'enterprise' ? 'enterprise' : 'post_pay');
      log.warn(
        {
          tenantId: row.tenant_id,
          accountId: row.account_id,
          billingMode: row.billing_mode,
          billingTier: row.billing_tier,
          planId,
        },
        'billing.startup_check: backfilling missing active subscriptions row from billing_controls',
      );
      // Backfill — idempotent guard with the same WHERE NOT EXISTS check so
      // two replicas racing the boot pass don't double-insert.
      await pool.query(
        `INSERT INTO subscriptions (account_id, plan_id, stripe_subscription_id, status, current_period_start, current_period_end)
         SELECT $1, $2, $3, 'active', NOW(), NOW() + INTERVAL '1 month'
         WHERE NOT EXISTS (
           SELECT 1 FROM subscriptions
           WHERE account_id = $1 AND status = 'active'
         )`,
        [row.account_id, planId, row.stripe_subscription_id ?? null],
      ).catch((err: Error) => {
        log.error({ accountId: row.account_id, error: err.message }, 'billing.startup_check: backfill insert failed');
      });
    }
  } catch (err) {
    // Never block boot on a diagnostic read.
    log.error(
      { error: (err as Error).message },
      'billing.startup_check: enterprise invariant query failed — skipping',
    );
  }
}
