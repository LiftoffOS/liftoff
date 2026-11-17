// Admin endpoints for the enterprise_contracts table.
//
// Renamed from enterprise-contracts-router.ts to enterprise-contract-handler.ts
// during the PR 0 conventions refactor. URL prefix moves from
// /enterprise-contracts/:accountId to /accounts/:accountId/enterprise-contract
// (account-scoped resource, not its own top-level noun).
//
// Mounted under /api/admin in src/admin/router.ts so adminAuthMiddleware
// (Firebase ID-token + DB-side is_platform_admin) gates every request.

import { Router, Request, Response } from 'express';
import { z } from 'zod';
import Stripe from 'stripe';
import { getPool } from '../infrastructure/database';
import { getStripeSecretKey } from '../infrastructure/secrets';
import { log } from '../infrastructure/logging';
import { logAdminAction } from './middleware';
import { adminError, wrapAdminResponse } from './conventions';
import { validateRequest } from './validate-request';
import { accountIdParam } from './zod-helpers';

let _stripe: Stripe | null = null;
async function getStripe(): Promise<Stripe> {
  if (!_stripe) _stripe = new Stripe(await getStripeSecretKey());
  return _stripe;
}

export const enterpriseContractsRouter = Router();

export const enterpriseContractBodySchema = z.object({
  includedOus: z.number().positive(),
  precommitExtraOus: z.number().nonnegative().optional(),
  includedRateUsdPerOu: z.number().positive(),
  precommitRateUsdPerOu: z.number().positive(),
  reloadRateUsdPerOu: z.number().positive(),
  stripeBilled: z.boolean().optional(),
  isAnnualPlan: z.boolean().optional(),
  annualTotalUsdCents: z.number().int().nonnegative().nullable().optional(),
  effectiveFrom: z.string().optional(),
  contractReference: z.string().optional(),
  notes: z.string().optional(),
});

export type EnterpriseContractBody = z.infer<typeof enterpriseContractBodySchema>;

// ── GET /accounts/:accountId/enterprise-contract ──────────────────────────
enterpriseContractsRouter.get(
  '/accounts/:accountId/enterprise-contract',
  validateRequest({ params: accountIdParam }),
  async (req: Request, res: Response) => {
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
    // GET writes no admin_action_audit row (plan-literal: PR 0's audit-action
    // normalization table covers only the PUT). Pass `null` so wrapAdminResponse
    // omits the `audit` key entirely.
    res.status(200).json(wrapAdminResponse({ contracts: rows }, null));
  },
);

// ── PUT /accounts/:accountId/enterprise-contract ──────────────────────────
enterpriseContractsRouter.put(
  '/accounts/:accountId/enterprise-contract',
  validateRequest({ params: accountIdParam, body: enterpriseContractBodySchema }),
  async (req: Request, res: Response) => {
    const { accountId } = req.params;
    const body = req.body as EnterpriseContractBody;

    const pool = getPool();

    // Detect interval change before upsert: if a Stripe sub already exists
    // for this account and the requested is_annual_plan differs from the
    // current one, Stripe doesn't allow flipping interval in place. Caller
    // must POST /api/internal/subscription/replace.
    if (typeof body.isAnnualPlan === 'boolean') {
      const existing = await pool.query<{ existing_annual: boolean | null; sub_id: string | null }>(
        `SELECT ec.is_annual_plan AS existing_annual, bc.stripe_subscription_id AS sub_id
           FROM billing_controls bc
           LEFT JOIN enterprise_contracts ec ON ec.account_id = bc.account_id
          WHERE bc.account_id = $1`,
        [accountId],
      );
      const e = existing.rows[0];
      if (e?.sub_id && e.existing_annual !== null && e.existing_annual !== body.isAnnualPlan) {
        res.status(409).json(
          adminError(
            'interval_change_requires_replace',
            'Annual/monthly flip cannot be applied in place — call POST /api/internal/subscription/replace.',
          ),
        );
        return;
      }
    }

    await upsertEnterpriseContract(accountId, body);
    await syncRatesToBillingAndStripe(accountId, {
      includedOus: body.includedOus,
      precommitExtraOus: body.precommitExtraOus ?? 0,
      includedRateUsdPerOu: body.includedRateUsdPerOu,
      precommitRateUsdPerOu: body.precommitRateUsdPerOu,
      reloadRateUsdPerOu: body.reloadRateUsdPerOu,
      stripeBilled: body.stripeBilled ?? true,
      isAnnualPlan: body.isAnnualPlan ?? false,
      annualTotalUsdCents: body.annualTotalUsdCents ?? null,
    });

    const adminAccount = (req as Request & { adminAccount?: { id: string; email: string } }).adminAccount;
    const audit = await logAdminAction(
      adminAccount?.id ?? (req as Request & { adminUid?: string }).adminUid ?? 'unknown',
      'account.enterprise_contract.upsert',
      'enterprise_contract',
      accountId,
      {
        includedOus: body.includedOus,
        includedRateUsdPerOu: body.includedRateUsdPerOu,
        precommitRateUsdPerOu: body.precommitRateUsdPerOu,
        reloadRateUsdPerOu: body.reloadRateUsdPerOu,
        stripeBilled: body.stripeBilled ?? true,
      },
      req,
    );
    log.info(
      {
        accountId,
        includedOus: body.includedOus,
        includedRateUsdPerOu: body.includedRateUsdPerOu,
        precommitRateUsdPerOu: body.precommitRateUsdPerOu,
        reloadRateUsdPerOu: body.reloadRateUsdPerOu,
        stripeBilled: body.stripeBilled ?? true,
      },
      'admin.enterprise_contract.upsert',
    );
    res.status(200).json(wrapAdminResponse({ ok: true }, audit));
  },
);

// Exported helpers — PR 5's enterprise-setup-handler reuses these to avoid
// duplicating the upsert + sync logic.
export async function upsertEnterpriseContract(
  accountId: string,
  body: EnterpriseContractBody,
): Promise<void> {
  const pool = getPool();
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
    [
      accountId,
      body.includedOus,
      body.precommitExtraOus ?? 0,
      body.includedRateUsdPerOu,
      body.precommitRateUsdPerOu,
      body.reloadRateUsdPerOu,
      body.stripeBilled,
      body.isAnnualPlan ?? false,
      body.annualTotalUsdCents ?? null,
      body.effectiveFrom ?? null,
      body.contractReference ?? null,
      body.notes ?? null,
    ],
  );
}

export async function syncRatesToBillingAndStripe(
  accountId: string,
  c: {
    includedOus: number;
    precommitExtraOus: number;
    includedRateUsdPerOu: number;
    precommitRateUsdPerOu: number;
    reloadRateUsdPerOu: number;
    stripeBilled: boolean;
    isAnnualPlan: boolean;
    annualTotalUsdCents: number | null;
  },
): Promise<void> {
  const pool = getPool();

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
    [
      accountId,
      c.includedOus,
      c.precommitExtraOus,
      c.includedRateUsdPerOu,
      c.precommitRateUsdPerOu,
      c.reloadRateUsdPerOu,
      c.isAnnualPlan,
    ],
  );

  const { rows } = await pool.query<{
    stripe_subscription_id: string | null;
    stripe_customer_id: string | null;
  }>(
    `SELECT stripe_subscription_id, stripe_customer_id FROM billing_controls WHERE account_id = $1`,
    [accountId],
  );
  const subId = rows[0]?.stripe_subscription_id;
  const customerId = rows[0]?.stripe_customer_id;
  if (!subId || !customerId) return;

  const stripe = await getStripe();

  // PR 1 / Gap E — retrieve first so we can guard mutations on sub status.
  // Two skip-and-return cases:
  //   (a) Sub deleted from Stripe (resource_missing) — metadata + price swap
  //       would 404 and surface as a 500 to ops. The billing_controls UPDATE
  //       above is the part we need for rate continuity; the Stripe-side work
  //       is moot once the sub is gone.
  //   (b) Sub exists but is not active/trialing (canceled, incomplete_expired,
  //       unpaid, past_due-outside-trial). Stripe rejects metadata updates on
  //       canceled subs; price swaps make no sense on a sub that won't bill.
  let live: Stripe.Subscription;
  try {
    live = await stripe.subscriptions.retrieve(subId, { expand: ['items.data.price'] });
  } catch (err) {
    if (
      err instanceof Stripe.errors.StripeInvalidRequestError &&
      err.code === 'resource_missing'
    ) {
      // Symmetric payload shape with the inactive-sub log below — operators
      // grepping on `status` see all skip cases. `resource_missing` isn't a
      // Stripe `Subscription.Status` value, so we use it as a sentinel.
      log.info(
        { accountId, subId, status: 'resource_missing' },
        'admin.enterprise_contract.sync_skipped_inactive_sub',
      );
      return;
    }
    throw err;
  }

  if (live.status !== 'active' && live.status !== 'trialing') {
    log.info(
      { accountId, subId, status: live.status },
      'admin.enterprise_contract.sync_skipped_inactive_sub',
    );
    return;
  }

  await stripe.subscriptions.update(subId, {
    metadata: {
      stripe_billed: String(c.stripeBilled),
      included_ous: String(c.includedOus),
      precommit_extra_ous: String(c.precommitExtraOus),
      included_rate_usd_per_ou: String(c.includedRateUsdPerOu),
      precommit_rate_usd_per_ou: String(c.precommitRateUsdPerOu),
      reload_rate_usd_per_ou: String(c.reloadRateUsdPerOu),
      is_annual_plan: String(c.isAnnualPlan),
    },
  });

  const monthlyFeeUsd =
    c.includedOus * c.includedRateUsdPerOu + c.precommitExtraOus * c.precommitRateUsdPerOu;
  const expectedFeeCents = c.stripeBilled
    ? c.isAnnualPlan
      ? c.annualTotalUsdCents ?? Math.round(monthlyFeeUsd * 100 * 10)
      : Math.round(monthlyFeeUsd * 100)
    : 0;
  const liveItem = live.items.data[0];
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
