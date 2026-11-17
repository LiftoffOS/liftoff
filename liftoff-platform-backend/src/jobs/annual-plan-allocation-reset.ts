// Annual Plan Monthly Counter Reset (pre-pay billing — Phase 1c, OU-native after PR 1)
//
// Problem: period-reset is triggered by invoice.paid in stripe-event-processor.
// Monthly subscribers get a monthly invoice → monthly counter reset. Annual
// subscribers pay once per year, so invoice.paid fires once per year — leaving
// annual subscribers without a monthly OU counter reset for 11 months.
//
// Fix: Cloud Scheduler job that runs on the 1st of every month (0 0 1 * *), finds
// all pre-pay annual subscribers (self-serve and Enterprise), and calls the shared
// doPeriodReset() function for each. doPeriodReset zeroes
// billing_controls.ous_consumed_this_period (the OU-native counter) and leaves
// reload_balance_usd untouched — user-paid credit carries over.
//
// Gated on ANNUAL_ALLOCATION_RESET_ENABLED=true, declared in Terraform on the
// platform_backend module rather than set with gcloud: Terraform owns the full
// container env, so a gcloud-set flag is reverted on the next apply.
// Auth: same X-Service-Auth / PLATFORM_CALLBACK_TOKEN pattern as maintenance/expire-agent-messages.ts.
//
// This module exports:
//   annualPlanAllocationResetRouter — Express router registered in src/app.ts
//   doPeriodReset(accountId, params) — shared function used by both this cron and
//                                      the billing-controls-internal-router /period-reset endpoint

import { Router, Request, Response } from 'express';
import { PoolClient } from 'pg';
import { getPool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { validateServiceAuth } from './_serviceAuth';

export const annualPlanAllocationResetRouter = Router();

// ── Shared period-reset logic ─────────────────────────────────────────────────
// Callable from both the HTTP endpoint handler and this cron job.
// Zeroes the OU consumption counter for the new period; clears the
// zero_prepaid_balance suspension if it was set in the prior period.
// reload_balance_usd is user-paid credit and carries over untouched.

export interface PeriodResetParams {
  billingPeriodStart: Date;
  stripePeriodStart?: Date | null;
  stripeSubscriptionId?: string | null;
}

export async function doPeriodReset(accountId: string, params: PeriodResetParams, clientOrPool?: PoolClient): Promise<void> {
  const pool = getPool();
  const db = clientOrPool ?? pool;
  await db.query(
    `UPDATE billing_controls SET
       ous_consumed_this_period         = 0,                                 -- zero rollover
       current_period_spend_usd         = 0,
       next_threshold_usd               = CASE WHEN graduated_at IS NOT NULL THEN 1000.00 ELSE 100.00 END,
       billing_period_start             = $2,
       stripe_period_start              = COALESCE($3, stripe_period_start),
       stripe_subscription_id           = COALESCE($4, stripe_subscription_id),
       threshold_charges_collected_usd  = 0,
       -- Referral bonus Operating Units do not roll over past the first billing
       -- period, matching how plan allowance already behaves. Only the OUs are
       -- cleared: referral_bonus_referral_id stays, so a redelivered invoice
       -- after the period rolls cannot grant a second bonus.
       referral_bonus_ous               = 0,
       -- reload_balance_usd is user-paid credit — carries over untouched.
       suspended                        = CASE WHEN suspended_reason='zero_prepaid_balance' THEN FALSE ELSE suspended END,
       suspended_reason                 = CASE WHEN suspended_reason='zero_prepaid_balance' THEN NULL  ELSE suspended_reason END,
       agents_stalled_notified_at       = NULL,
       spend_updated_at                 = NOW(),
       updated_at                       = NOW()
     WHERE account_id = $1`,
    [accountId, params.billingPeriodStart, params.stripePeriodStart ?? null, params.stripeSubscriptionId ?? null],
  );
}

// ── Main reset logic ──────────────────────────────────────────────────────────

interface AnnualSubscriberRow {
  account_id: string;
  stripe_customer_id: string | null;
  billing_period_start: Date | null;
}

async function runAnnualAllocationReset(): Promise<{ processed: number; succeeded: number; failed: number }> {
  const pool = getPool();

  // Find all pre-pay annual subscribers not yet reset this calendar month.
  // billing_period_start < date_trunc('month', NOW()) prevents double-resetting
  // accounts that were already reset via invoice.paid → period-reset this month.
  //
  // Allowances land on CALENDAR months, not on the subscription anniversary, so
  // a term starting mid-month draws its initial allowance plus twelve monthly
  // resets across twelve months: thirteen allowances for twelve months paid.
  // That is deliberate. Anniversary alignment would mean carrying a per-account
  // day-of-month and defining what the 31st means in February, for an error
  // that is bounded at one month and falls in the customer's favour.
  const { rows } = await pool.query<AnnualSubscriberRow>(
    `SELECT bc.account_id, bc.stripe_customer_id, bc.billing_period_start
       FROM billing_controls bc
      WHERE bc.billing_mode               = 'pre_pay'
        AND bc.is_annual_plan             = TRUE
        AND bc.stripe_subscription_id IS NOT NULL
        AND (bc.plan_type IS NOT NULL OR bc.billing_tier = 'enterprise')
        AND (bc.billing_period_start IS NULL
             OR bc.billing_period_start < date_trunc('month', NOW()))`,
  );

  log.info({ count: rows.length }, 'annual-allocation-reset: found annual subscribers to reset');

  let succeeded = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      await doPeriodReset(row.account_id, {
        billingPeriodStart: new Date(),
        stripePeriodStart: null,
        stripeSubscriptionId: null,
      });
      succeeded++;
      log.info({ accountId: row.account_id }, 'annual-allocation-reset: reset succeeded');
    } catch (error) {
      failed++;
      log.error(
        { accountId: row.account_id, error: (error as Error).message },
        'annual-allocation-reset: reset failed — continuing to next account',
      );
    }
  }

  return { processed: rows.length, succeeded, failed };
}

// ── Route handler ─────────────────────────────────────────────────────────────

annualPlanAllocationResetRouter.post('/annual-plan-allocation-reset', async (req: Request, res: Response) => {
  if (!validateServiceAuth(req, res)) return;

  // A scheduled job that cannot do its work must not report that it did. A 200
  // here leaves Cloud Scheduler green indefinitely while every annual subscriber
  // goes without a reset, which is the one failure nothing else in this estate
  // would surface. Disabling the flag therefore means pausing the scheduler too:
  // the pair is the switch, and a red job is how a half-thrown switch is found.
  if (process.env.ANNUAL_ALLOCATION_RESET_ENABLED !== 'true') {
    log.error({}, 'annual-allocation-reset: refused — ANNUAL_ALLOCATION_RESET_ENABLED not set to true');
    res.status(503).json({ ok: false, error: 'ANNUAL_ALLOCATION_RESET_ENABLED not true' });
    return;
  }

  try {
    const result = await runAnnualAllocationReset();
    log.info(result, 'annual-allocation-reset: completed');
    res.status(200).json({ ok: true, ...result });
  } catch (err) {
    log.error({ error: (err as Error).message }, 'annual-allocation-reset: failed');
    res.status(500).json({ error: 'Internal server error' });
  }
});
