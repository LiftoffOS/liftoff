// Admin endpoints for managing enterprise_contracts rows.
// Mounted under /api/admin in src/admin/router.ts so adminAuthMiddleware
// (Firebase ID-token + admin custom claim) gates every request.

import { Router, Request, Response } from 'express';
import Stripe from 'stripe';
import { getPool } from '../infrastructure/database';
import { getStripeSecretKey } from '../infrastructure/secrets';
import { log } from '../infrastructure/logging';
import { logAdminAction } from './middleware';

let _stripe: Stripe | null = null;
async function getStripe(): Promise<Stripe> {
  if (!_stripe) _stripe = new Stripe(await getStripeSecretKey());
  return _stripe;
}

export const enterpriseContractsRouter = Router();

// List/get current contract for an account.
enterpriseContractsRouter.get('/enterprise-contracts/:accountId', async (req: Request, res: Response) => {
  const { accountId } = req.params;
  const pool = getPool();
  const { rows } = await pool.query(
    `SELECT account_id, included_ous, precommit_extra_ous,
            included_rate_usd_per_ou, precommit_rate_usd_per_ou, reload_rate_usd_per_ou,
            stripe_billed, is_annual_plan, annual_total_usd_cents,
            effective_from, effective_to, contract_reference, notes, updated_at
       FROM enterprise_contracts
      WHERE account_id = $1
      ORDER BY effective_from DESC`,
    [accountId],
  );
  res.status(200).json({ contracts: rows });
});

// Upsert the active contract.
enterpriseContractsRouter.put('/enterprise-contracts/:accountId', async (req: Request, res: Response) => {
  const { accountId } = req.params;
  const {
    includedOus, precommitExtraOus,
    includedRateUsdPerOu, precommitRateUsdPerOu, reloadRateUsdPerOu,
    stripeBilled,
    isAnnualPlan,
    annualTotalUsdCents,
    effectiveFrom, contractReference, notes,
  } = req.body as {
    includedOus?: number; precommitExtraOus?: number;
    includedRateUsdPerOu?: number; precommitRateUsdPerOu?: number; reloadRateUsdPerOu?: number;
    stripeBilled?: boolean; isAnnualPlan?: boolean; annualTotalUsdCents?: number;
    effectiveFrom?: string; contractReference?: string; notes?: string;
  };

  for (const [k, v] of Object.entries({ includedOus, includedRateUsdPerOu, precommitRateUsdPerOu, reloadRateUsdPerOu })) {
    if (typeof v !== 'number' || v <= 0) {
      res.status(400).json({ error: 'invalid_or_missing_field', field: k });
      return;
    }
  }

  const pool = getPool();

  // Detect interval change before upsert: if a Stripe sub already exists for this
  // account and the requested is_annual_plan differs from the current one, the
  // change cannot be applied in place — Stripe doesn't allow flipping recurring
  // interval. Caller must POST /provision-enterprise to replace the sub.
  if (typeof isAnnualPlan === 'boolean') {
    const existing = await pool.query<{ existing_annual: boolean | null; sub_id: string | null }>(
      `SELECT ec.is_annual_plan AS existing_annual, bc.stripe_subscription_id AS sub_id
         FROM billing_controls bc
         LEFT JOIN enterprise_contracts ec ON ec.account_id = bc.account_id
        WHERE bc.account_id = $1`,
      [accountId],
    );
    const e = existing.rows[0];
    if (e?.sub_id && e.existing_annual !== null && e.existing_annual !== isAnnualPlan) {
      res.status(409).json({ error: 'interval_change_requires_replace',
        detail: 'Annual/monthly flip cannot be applied in place — call POST /api/internal/subscription/replace.' });
      return;
    }
  }

  await pool.query(
    `INSERT INTO enterprise_contracts (
       account_id, included_ous, precommit_extra_ous,
       included_rate_usd_per_ou, precommit_rate_usd_per_ou, reload_rate_usd_per_ou,
       stripe_billed, is_annual_plan, annual_total_usd_cents,
       effective_from, contract_reference, notes
     ) VALUES ($1, $2, $3, $4, $5, $6, COALESCE($7, TRUE), COALESCE($8, FALSE), $9, COALESCE($10, NOW()), $11, $12)
     ON CONFLICT (account_id) DO UPDATE SET
       included_ous                = EXCLUDED.included_ous,
       precommit_extra_ous         = EXCLUDED.precommit_extra_ous,
       included_rate_usd_per_ou    = EXCLUDED.included_rate_usd_per_ou,
       precommit_rate_usd_per_ou   = EXCLUDED.precommit_rate_usd_per_ou,
       reload_rate_usd_per_ou      = EXCLUDED.reload_rate_usd_per_ou,
       stripe_billed               = EXCLUDED.stripe_billed,
       is_annual_plan              = EXCLUDED.is_annual_plan,
       annual_total_usd_cents      = EXCLUDED.annual_total_usd_cents,
       effective_from              = EXCLUDED.effective_from,
       contract_reference          = COALESCE(EXCLUDED.contract_reference, enterprise_contracts.contract_reference),
       notes                       = COALESCE(EXCLUDED.notes,              enterprise_contracts.notes),
       updated_at                  = NOW()`,
    [accountId, includedOus, precommitExtraOus ?? 0,
     includedRateUsdPerOu, precommitRateUsdPerOu, reloadRateUsdPerOu,
     stripeBilled, isAnnualPlan ?? false, annualTotalUsdCents ?? null,
     effectiveFrom ?? null, contractReference ?? null, notes ?? null],
  );

  await syncRatesToBillingAndStripe(accountId, {
    includedOus: includedOus as number, precommitExtraOus: precommitExtraOus ?? 0,
    includedRateUsdPerOu: includedRateUsdPerOu as number,
    precommitRateUsdPerOu: precommitRateUsdPerOu as number,
    reloadRateUsdPerOu: reloadRateUsdPerOu as number,
    stripeBilled: stripeBilled ?? true,
    isAnnualPlan: isAnnualPlan ?? false,
    annualTotalUsdCents: annualTotalUsdCents ?? null,
  });

  const adminId = (req as Request & { adminUid?: string }).adminUid ?? 'unknown';
  await logAdminAction(
    adminId,
    'admin.enterprise_contract.upsert',
    'enterprise_contract',
    accountId,
    { includedOus, includedRateUsdPerOu, precommitRateUsdPerOu, reloadRateUsdPerOu, stripeBilled: stripeBilled ?? true },
    req,
  );
  log.info({ accountId, includedOus, includedRateUsdPerOu, precommitRateUsdPerOu, reloadRateUsdPerOu,
             stripeBilled: stripeBilled ?? true },
    'admin.enterprise_contract.upsert');
  res.status(200).json({ ok: true });
});

async function syncRatesToBillingAndStripe(accountId: string, c: {
  includedOus: number; precommitExtraOus: number;
  includedRateUsdPerOu: number; precommitRateUsdPerOu: number; reloadRateUsdPerOu: number;
  stripeBilled: boolean;
  isAnnualPlan: boolean;
  annualTotalUsdCents: number | null;
}): Promise<void> {
  const pool = getPool();

  // 1. Live rates on billing_controls.
  await pool.query(
    `UPDATE billing_controls SET
       plan_included_ous         = $2,
       precommit_extra_ous       = $3,
       included_rate_usd_per_ou  = $4,
       precommit_rate_usd_per_ou = $5,
       reload_rate_usd_per_ou    = $6,
       is_annual_plan            = $7,
       updated_at                = NOW()
     WHERE account_id = $1`,
    [accountId, c.includedOus, c.precommitExtraOus,
     c.includedRateUsdPerOu, c.precommitRateUsdPerOu, c.reloadRateUsdPerOu, c.isAnnualPlan],
  );

  const { rows } = await pool.query<{ stripe_subscription_id: string | null; stripe_customer_id: string | null }>(
    `SELECT stripe_subscription_id, stripe_customer_id FROM billing_controls WHERE account_id = $1`,
    [accountId],
  );
  const subId = rows[0]?.stripe_subscription_id;
  const customerId = rows[0]?.stripe_customer_id;
  if (!subId || !customerId) return;

  const stripe = await getStripe();

  // Refresh metadata on the existing subscription.
  await stripe.subscriptions.update(subId, {
    metadata: {
      stripe_billed:             String(c.stripeBilled),
      included_ous:              String(c.includedOus),
      precommit_extra_ous:       String(c.precommitExtraOus),
      included_rate_usd_per_ou:  String(c.includedRateUsdPerOu),
      precommit_rate_usd_per_ou: String(c.precommitRateUsdPerOu),
      reload_rate_usd_per_ou:    String(c.reloadRateUsdPerOu),
      is_annual_plan:            String(c.isAnnualPlan),
    },
  });

  // Recompute the recurring fee. Swap price if it changed.
  const monthlyFeeUsd = c.includedOus * c.includedRateUsdPerOu + c.precommitExtraOus * c.precommitRateUsdPerOu;
  const expectedFeeCents = c.stripeBilled
    ? c.isAnnualPlan
      ? (c.annualTotalUsdCents ?? Math.round(monthlyFeeUsd * 100 * 10))
      : Math.round(monthlyFeeUsd * 100)
    : 0;
  const live = await stripe.subscriptions.retrieve(subId, { expand: ['items.data.price'] });
  const liveItem  = live.items.data[0];
  const liveCents = (liveItem.price as Stripe.Price).unit_amount ?? 0;
  if (liveCents === expectedFeeCents) return;

  const newPrice = await stripe.prices.create({
    currency: 'usd',
    unit_amount: expectedFeeCents,
    product_data: {
      name: c.stripeBilled
        ? `Enterprise — ${c.includedOus.toLocaleString()} included + ${c.precommitExtraOus.toLocaleString()} precommit OUs / mo`
        : `Enterprise (internal) — ${c.includedOus.toLocaleString()} included + ${c.precommitExtraOus.toLocaleString()} precommit OUs / mo (Stripe $0)`,
    },
    recurring: { interval: c.isAnnualPlan ? 'year' : 'month' },
  });
  await stripe.subscriptions.update(subId, {
    items: [{ id: liveItem.id, price: newPrice.id }],
    proration_behavior: 'create_prorations',
  });
}
