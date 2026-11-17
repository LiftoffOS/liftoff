// Phase 0: Threshold Charge Service
//
// Graduated threshold charging: $100→$200→$500→$1,000→$1,000 (ongoing).
// After $1,800 cumulative spend in a period, the account graduates and
// every subsequent period resets to a $1,000 starting threshold.
//
// runThresholdCheck() uses optimistic locking — no SELECT FOR UPDATE needed.
// The UPDATE succeeds only when both conditions still hold:
//   (a) next_threshold_usd hasn't been advanced by a concurrent writer
//   (b) current_period_spend_usd is still >= the threshold
// If the UPDATE races, rowCount = 0 and we return silently.

import { createHmac } from 'crypto';
import { getPool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';

const BILLING_SERVICE_URL = process.env.BILLING_SERVICE_URL ?? '';

// Graduated threshold schedule. triggerAt = cumulative spend that fires a
// charge; chargeAmount = amount to charge at that trigger.
const THRESHOLD_SCHEDULE: { triggerAt: number; chargeAmount: number }[] = [
  { triggerAt: 100,  chargeAmount: 100  },
  { triggerAt: 300,  chargeAmount: 200  },
  { triggerAt: 800,  chargeAmount: 500  },
  { triggerAt: 1800, chargeAmount: 1000 },
];
const ONGOING_INCREMENT = 1000;

export function getThresholdCharge(nextThresholdUsd: number): { chargeAmount: number; nextTrigger: number } {
  const scheduled = THRESHOLD_SCHEDULE.find(s => s.triggerAt === nextThresholdUsd);
  if (scheduled) {
    const idx = THRESHOLD_SCHEDULE.indexOf(scheduled);
    const nextTrigger = THRESHOLD_SCHEDULE[idx + 1]?.triggerAt ?? (nextThresholdUsd + ONGOING_INCREMENT);
    return { chargeAmount: scheduled.chargeAmount, nextTrigger };
  }
  // Ongoing $1K phase — every period after graduation
  return { chargeAmount: ONGOING_INCREMENT, nextTrigger: nextThresholdUsd + ONGOING_INCREMENT };
}

interface BillingControlsRow {
  account_id: string;
  current_period_spend_usd: string;
  next_threshold_usd: string;
  suspended: boolean;
  billing_mode: string;
  billing_exempt: boolean;
  stripe_subscription_id: string | null;
  stripe_period_start: Date | null;
  stripe_customer_id: string | null;
}

async function getControls(accountId: string): Promise<BillingControlsRow | null> {
  const pool = getPool();
  const result = await pool.query<BillingControlsRow>(
    `SELECT account_id, current_period_spend_usd, next_threshold_usd,
            suspended, billing_mode, billing_exempt,
            stripe_subscription_id, stripe_period_start, stripe_customer_id
     FROM billing_controls WHERE account_id = $1`,
    [accountId],
  );
  return result.rows[0] ?? null;
}

// Calls liftoff-billing to create a Stripe InvoiceItem + auto-collecting Invoice.
// Uses BILLING_SERVICE_TOKEN HMAC signing (same scheme as billing-controls-internal-router).
async function callBillingTriggerCharge(
  stripeCustomerId: string,
  chargeAmount: number,
  idempotencyKey: string,
  metadata: Record<string, string>,
): Promise<void> {
  const token = process.env.BILLING_SERVICE_TOKEN;
  if (!token) throw new Error('BILLING_SERVICE_TOKEN not configured');

  const path = '/api/internal/billing/threshold-charge';
  const body = JSON.stringify({ stripeCustomerId, chargeAmountUsd: chargeAmount, idempotencyKey, metadata });
  const timestamp = Date.now();
  const signature = createHmac('sha256', token)
    .update(`POST\n${path}\n${timestamp}\n${body}`)
    .digest('hex');

  const resp = await fetch(`${BILLING_SERVICE_URL}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Billing-Timestamp': String(timestamp),
      'X-Billing-Signature': signature,
    },
    body,
  });

  if (!resp.ok) {
    const text = await resp.text().catch(() => '');
    throw new Error(`billing trigger-charge failed ${resp.status}: ${text.slice(0, 200)}`);
  }
}

export async function runThresholdCheck(accountId: string): Promise<void> {
  const pool = getPool();

  const controls = await getControls(accountId);
  if (!controls) {
    log.warn({ accountId }, 'billing.threshold_check: billing_controls row not found — skipping');
    return;
  }
  if (controls.billing_mode === 'pre_pay') {
    log.info({ accountId }, 'billing.threshold_check: skipping — account is pre_pay');
    return;
  }
  if (controls.suspended) return;

  const currentSpend = parseFloat(controls.current_period_spend_usd);
  const nextThreshold = parseFloat(controls.next_threshold_usd);

  if (currentSpend < nextThreshold) return;

  if (!controls.stripe_subscription_id || !controls.stripe_period_start || !controls.stripe_customer_id) {
    log.warn({ accountId }, 'billing.threshold_check: stripe_subscription_id, stripe_period_start, or stripe_customer_id not set — skipping');
    return;
  }

  const { chargeAmount, nextTrigger } = getThresholdCharge(nextThreshold);
  const periodStartTs = controls.stripe_period_start.toISOString();
  const idempotencyKey = `threshold-${controls.stripe_subscription_id}-${periodStartTs}-${nextThreshold}`;

  // Optimistic advance: only succeeds if no concurrent writer changed next_threshold_usd
  // and the spend is still above the threshold and the account is still active.
  const advanceResult = await pool.query(
    `UPDATE billing_controls
     SET next_threshold_usd = $1, updated_at = NOW()
     WHERE account_id               = $2
       AND next_threshold_usd       = $3
       AND current_period_spend_usd >= $3
       AND NOT suspended
     RETURNING account_id`,
    [nextTrigger, accountId, nextThreshold],
  );

  if ((advanceResult.rowCount ?? 0) === 0) {
    // Lost the race — another instance already advanced or conditions changed
    return;
  }

  // Exempt accounts (internal) reach a threshold like anyone else and
  // then stop here. The threshold advance above STANDS — exempt is settled by
  // definition — which is what keeps outstanding_balance_usd at zero for them:
  // no invoice is created, so no payment can fail, so nothing accrues and
  // nothing suspends. Everything upstream already happened: the spend counter
  // moved, the buckets drained, the dashboard is truthful.
  //
  // The amount is logged so an exempt account's real cost is still visible; it
  // is simply never invoiced.
  if (controls.billing_exempt) {
    log.info(
      { accountId, wouldHaveChargedUsd: chargeAmount, nextThreshold, nextTrigger, billingExempt: true },
      'billing.threshold_check: charge skipped — account is billing_exempt (threshold advanced, treated as settled)',
    );
    return;
  }

  try {
    await callBillingTriggerCharge(controls.stripe_customer_id, chargeAmount, idempotencyKey, {
      type:                   'threshold',
      threshold_level:        String(nextThreshold),
      stripe_subscription_id: controls.stripe_subscription_id,
    });

    log.info({ accountId, chargeAmount, nextThreshold, nextTrigger }, 'billing.threshold_check: charge triggered');
  } catch (err) {
    // Compensating rollback: restore next_threshold_usd so the check will re-fire.
    // This is best-effort — if the rollback also fails, the Cloud Tasks retry
    // will hit the already-advanced threshold and the optimistic lock will
    // pass again once the spend catches up.
    await pool.query(
      `UPDATE billing_controls SET next_threshold_usd = $1 WHERE account_id = $2`,
      [nextThreshold, accountId],
    ).catch((rollbackErr: Error) =>
      log.error({ err: rollbackErr.message, accountId }, 'billing.threshold_check: rollback failed after charge error'),
    );
    throw err;
  }
}
