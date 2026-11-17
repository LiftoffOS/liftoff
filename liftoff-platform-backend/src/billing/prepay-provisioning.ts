// Seeds the billing_controls row for a workspace that has not subscribed.
//
// Without a row, a workspace has no billing mode, no rates and nothing to add
// credit to: /current-usage answers with defaults, the Settings billing tab
// renders as though billing were not set up, and a top-up has no row to land
// on. The row is what makes a workspace fundable, so it is created at provision
// time rather than waiting for a Stripe subscription to create one.
//
// The row is seeded SUSPENDED. A pay-as-you-go workspace holds no credit until
// somebody buys some, and `suspended` is the flag that says a funded workspace
// has run out — the same state an unfunded one is in. Clearing it belongs to the
// top-up path, not to this one.
//
// Which is exactly why a deployment with no billing system gets NO row: there
// would be no top-up path to clear it, and `execution-guard` LEFT JOINs this
// table and coalesces suspension to FALSE, so an account with no row runs
// while an account with this row never would. The provider decides — see
// src/billing/provider.ts.

import { getPool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { getBillingProvider } from './provider';

// The rate every self-serve plan already charges for reload credit. Used only
// when billing_system_settings cannot answer: a zero rate bills nothing, so
// falling back to zero would hand out free compute rather than degrade.
const FALLBACK_RATE_USD_PER_OU = 0.031250;

const RATE_TTL_MS = 5 * 60 * 1000;

interface RateCache {
  value: number;
  fetchedAt: number;
}
let rateCache: RateCache | null = null;

export function _resetPayAsYouGoRateCacheForTesting(): void {
  rateCache = null;
}

// Mirrors getOuDefinitionRateUsd in cost-attribution/ou-bucket-service: TTL
// cache, loud on a missing or nonsensical value, and a transient DB error does
// not poison the cache so the next call retries.
async function getPayAsYouGoRateUsdPerOu(): Promise<number> {
  if (rateCache && Date.now() - rateCache.fetchedAt < RATE_TTL_MS) {
    return rateCache.value;
  }
  try {
    const { rows } = await getPool().query<{ value: string }>(
      `SELECT value::text AS value FROM billing_system_settings WHERE key = 'payg_rate_usd_per_ou'`,
    );
    if (!rows[0]) {
      log.error({ key: 'payg_rate_usd_per_ou', fallback: FALLBACK_RATE_USD_PER_OU },
        'billing.prepay_provisioning: billing_system_settings row missing — falling back');
      rateCache = { value: FALLBACK_RATE_USD_PER_OU, fetchedAt: Date.now() };
      return FALLBACK_RATE_USD_PER_OU;
    }
    const value = parseFloat(rows[0].value);
    if (!(value > 0)) {
      log.error({ key: 'payg_rate_usd_per_ou', raw: rows[0].value, fallback: FALLBACK_RATE_USD_PER_OU },
        'billing.prepay_provisioning: billing_system_settings value not positive — falling back');
      rateCache = { value: FALLBACK_RATE_USD_PER_OU, fetchedAt: Date.now() };
      return FALLBACK_RATE_USD_PER_OU;
    }
    rateCache = { value, fetchedAt: Date.now() };
    return value;
  } catch (err) {
    log.error({ error: (err as Error).message, fallback: FALLBACK_RATE_USD_PER_OU },
      'billing.prepay_provisioning: failed to load payg_rate_usd_per_ou — falling back for this call only');
    return FALLBACK_RATE_USD_PER_OU;
  }
}

/**
 * Create the pay-as-you-go billing_controls row for an account, if it has none.
 *
 * DO NOTHING on conflict, so this never disturbs an account that already has a
 * row: a later subscription activation owns the plan columns and overwrites the
 * rates, and an exemption or suspension an operator set by hand survives.
 *
 * All three rate columns carry the same rate even though only the reload one is
 * reachable while plan_included_ous and precommit_extra_ous are zero. Two
 * reasons: a referral bonus widens the precommit band on a workspace that has
 * no plan, and subscription activation COALESCEs onto whatever is already here
 * when a caller supplies no rates of its own. A zero left in either column
 * bills nothing.
 *
 * `stripe_customer_id` is copied from the account because it is what makes the
 * row addressable. liftoff-billing knows customers, not accounts, and its
 * callbacks resolve `/controls/cus_.../prepaid-topped-up` through this column;
 * without it the first top-up on a workspace that never subscribed answered
 * 404 and credited nothing. The account's customer exists from signup, and
 * subscription activation COALESCEs onto whatever is here.
 */
export async function ensurePayAsYouGoControlsRow(accountId: string): Promise<void> {
  // A deployment with no billing system gets NO row, which is not a lesser
  // version of this — it is the admitted state. The row below is born
  // `suspended='zero_prepaid_balance'` and there would be no way to fund it,
  // while `execution-guard` LEFT JOINs this table and coalesces suspension to
  // FALSE, so an account with no row runs. See src/billing/provider.ts.
  const billing = getBillingProvider();
  if (!billing.seedsPrepaidControls) {
    log.info(
      { accountId, provider: billing.kind },
      'billing.prepay_provisioning: no billing system configured — skipping the controls row',
    );
    return;
  }

  const rate = await getPayAsYouGoRateUsdPerOu();
  await getPool().query(
    `INSERT INTO billing_controls (
       account_id, billing_mode, suspended, suspended_reason,
       plan_included_ous, precommit_extra_ous,
       included_rate_usd_per_ou, precommit_rate_usd_per_ou, reload_rate_usd_per_ou,
       billing_exempt, stripe_customer_id
     )
     VALUES ($1, 'pre_pay', TRUE, 'zero_prepaid_balance',
             0, 0,
             $2, $2, $2,
             COALESCE((SELECT is_internal FROM accounts WHERE id = $1), FALSE),
             (SELECT stripe_customer_id FROM accounts WHERE id = $1))
     ON CONFLICT (account_id) DO NOTHING`,
    [accountId, rate],
  );
}
