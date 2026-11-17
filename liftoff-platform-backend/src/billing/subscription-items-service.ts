// Subscription Items Service — Phase 3
//
// Responsibilities:
//   1. syncSubscriptionItems(subscriptionId) — called by /subscription-items/sync
//      endpoint on every customer.subscription.created/updated event from liftoff-billing.
//      Fetches the Stripe subscription, classifies each line item, and upserts into
//      subscription_items.
//
//   2. updateAgentQuantity(accountId) — called after internal agent status transitions
//      involving 'active'. Counts active agents across all tenants for the account and
//      updates the 'agent' subscription item quantity in Stripe.
//
//   3. updatePlatformFeeQuantity(accountId) — called after accounts.headcount changes.
//      Resolves the correct tier from platform_fee_catalog, sets Stripe subscription item
//      quantity = headcount (and swaps price if tier changed), then syncs locally.
//      Platform fee = headcount × price_per_headcount_cents for the account's tier.
//
// classifyItemType() precedence (highest → lowest):
//   1. platform_fee_catalog.stripe_price_id match            → 'platform'
//   2. Stripe price metadata field `liftoff_type` if present → as-is (CS-controlled)
//   3. Price nickname contains 'agent'                       → 'agent'
//   4. Price nickname contains 'overage' or 'ou'             → 'ou_usage'
//   5. Fallback                                              → 'addon'

import Stripe from 'stripe';
import { getPool, withAdminScope } from '../infrastructure/database';
import { getStripeSecretKey } from '../infrastructure/secrets';
import { log } from '../infrastructure/logging';
import { syncAddonEntitlements } from './addon-service';

// ── Lazy Stripe singleton ──────────────────────────────────────────────────────

let _stripe: Stripe | null = null;

async function getStripe(): Promise<Stripe> {
  if (!_stripe) {
    _stripe = new Stripe(await getStripeSecretKey());
  }
  return _stripe;
}

// ── Item type classification ───────────────────────────────────────────────────

type SubscriptionItemType = 'platform' | 'agent' | 'ou_usage' | 'addon';

// Accepts an already-fetched Stripe.Price (expanded on the subscription).
// No separate stripe.prices.retrieve() call — caller is responsible for expanding.
async function classifyItemType(
  price: Stripe.Price | null,
): Promise<SubscriptionItemType> {
  if (!price) return 'addon';

  const pool = getPool();

  // 1. Check platform_fee_catalog (once populated in Phase 5)
  const catalogRow = await pool.query<{ tier_key: string }>(
    `SELECT tier_key FROM platform_fee_catalog WHERE stripe_price_id = $1 AND active = TRUE LIMIT 1`,
    [price.id],
  );
  if (catalogRow.rows.length > 0) return 'platform';

  // 2. CS can set metadata.liftoff_type = 'agent' | 'ou_usage' | 'platform' | 'addon'
  const metaType = price.metadata?.['liftoff_type'] as SubscriptionItemType | undefined;
  if (metaType && ['platform', 'agent', 'ou_usage', 'addon'].includes(metaType)) {
    return metaType;
  }

  // 3. Infer from price nickname
  const nick = (price.nickname ?? '').toLowerCase();
  if (nick.includes('agent')) return 'agent';
  if (nick.includes('overage') || nick.includes('ou')) return 'ou_usage';

  return 'addon';
}

// ── Platform fee tier resolution ───────────────────────────────────────────────

interface PlatformFeeTierRow {
  tier_key:                  string;
  stripe_price_id:           string;
  price_per_headcount_cents: number;
}

async function resolvePlatformFeeTier(headcount: number): Promise<PlatformFeeTierRow | null> {
  const pool = getPool();
  const result = await pool.query<PlatformFeeTierRow>(
    `SELECT tier_key, stripe_price_id, price_per_headcount_cents
     FROM platform_fee_catalog
     WHERE min_headcount <= $1
       AND (max_headcount IS NULL OR max_headcount >= $1)
       AND active = TRUE
     ORDER BY min_headcount DESC
     LIMIT 1`,
    [headcount],
  );
  return result.rows[0] ?? null;
}

// ── syncSubscriptionItems ──────────────────────────────────────────────────────

export async function syncSubscriptionItems(subscriptionId: string): Promise<void> {
  const pool = getPool();
  const stripe = await getStripe();

  // Resolve account_id from billing_controls (written by /init when subscription is created)
  const accountRow = await pool.query<{ account_id: string }>(
    `SELECT account_id FROM billing_controls WHERE stripe_subscription_id = $1`,
    [subscriptionId],
  );
  if (accountRow.rows.length === 0) {
    log.warn({ subscriptionId }, 'subscription-items: no billing_controls row for subscription — skipping sync');
    return;
  }
  const accountId = accountRow.rows[0].account_id;

  // Fetch subscription with items expanded from Stripe.
  // expand: ['items.data.price'] ensures each item.price is a full Stripe.Price object,
  // so classifyItemType receives it directly without a second stripe.prices.retrieve() call.
  let sub: Stripe.Subscription;
  try {
    sub = await stripe.subscriptions.retrieve(subscriptionId, {
      expand: ['items.data.price'],
    });
  } catch (err) {
    log.error({ error: (err as Error).message, subscriptionId }, 'subscription-items: failed to fetch Stripe subscription');
    throw err;
  }

  for (const item of sub.items.data) {
    const price = item.price ?? null;
    const priceId = price?.id ?? null;
    const itemType = await classifyItemType(price);

    // For platform items, look up which tier key matches
    let platformFeeTierKey: string | null = null;
    if (itemType === 'platform' && priceId) {
      const tierRow = await pool.query<{ tier_key: string }>(
        `SELECT tier_key FROM platform_fee_catalog WHERE stripe_price_id = $1 LIMIT 1`,
        [priceId],
      );
      platformFeeTierKey = tierRow.rows[0]?.tier_key ?? null;
    }

    await pool.query(
      `INSERT INTO subscription_items
         (account_id, stripe_subscription_id, stripe_subscription_item_id, item_type,
          stripe_price_id, quantity, platform_fee_tier_key)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (stripe_subscription_item_id)
       DO UPDATE SET
         quantity              = EXCLUDED.quantity,
         stripe_price_id       = EXCLUDED.stripe_price_id,
         platform_fee_tier_key = EXCLUDED.platform_fee_tier_key,
         updated_at            = NOW()`,
      [accountId, subscriptionId, item.id, itemType, priceId, item.quantity ?? 1, platformFeeTierKey],
    );
  }

  log.info(
    { accountId, subscriptionId, itemCount: sub.items.data.length },
    'subscription-items: sync complete',
  );

  // Sync add-on entitlements based on the freshly-upserted subscription items.
  // Non-fatal: a failure here should not roll back the subscription_items sync.
  await syncAddonEntitlements(accountId).catch((err: Error) =>
    log.error({ error: err.message, accountId, subscriptionId }, 'subscription-items: syncAddonEntitlements failed'),
  );
}

// ── updatePlatformFeeQuantity ──────────────────────────────────────────────────
// Called when accounts.headcount changes. Resolves the correct tier, then sets
// the Stripe platform subscription item quantity = headcount. If the account has
// grown into a new tier, also swaps the price ID on the subscription item so the
// correct per-headcount rate applies.

export async function updatePlatformFeeQuantity(accountId: string): Promise<void> {
  const pool = getPool();

  // Read current headcount
  const accountRow = await pool.query<{ headcount: number }>(
    `SELECT headcount FROM accounts WHERE id = $1`,
    [accountId],
  );
  if (accountRow.rows.length === 0) return;
  const headcount = accountRow.rows[0].headcount;

  // Resolve the correct tier for this headcount
  const tier = await resolvePlatformFeeTier(headcount);
  if (!tier) {
    log.warn({ accountId, headcount }, 'subscription-items: no platform fee tier found for headcount');
    return;
  }

  // Find the platform subscription item for this account
  const itemRow = await pool.query<{ stripe_subscription_item_id: string; stripe_price_id: string | null }>(
    `SELECT stripe_subscription_item_id, stripe_price_id FROM subscription_items
     WHERE account_id = $1 AND item_type = 'platform'
     LIMIT 1`,
    [accountId],
  );
  if (itemRow.rows.length === 0) {
    // Subscription not yet set up or sync hasn't run — nothing to update
    return;
  }

  const { stripe_subscription_item_id: itemId, stripe_price_id: currentPriceId } = itemRow.rows[0];
  const priceChanged = currentPriceId !== tier.stripe_price_id;

  try {
    const stripe = await getStripe();

    // Build the update — always set quantity; swap price only when tier changes
    const updateParams: Stripe.SubscriptionItemUpdateParams = { quantity: headcount };
    if (priceChanged && tier.stripe_price_id) {
      updateParams.price = tier.stripe_price_id;
    }

    await stripe.subscriptionItems.update(itemId, updateParams);

    // Keep subscription_items in sync with the new quantity and tier
    await pool.query(
      `UPDATE subscription_items
       SET quantity              = $2,
           stripe_price_id       = $3,
           platform_fee_tier_key = $4,
           updated_at            = NOW()
       WHERE stripe_subscription_item_id = $1`,
      [itemId, headcount, tier.stripe_price_id, tier.tier_key],
    );

    log.info({ accountId, headcount, tierKey: tier.tier_key, priceChanged }, 'subscription-items: platform fee quantity updated');
  } catch (err) {
    log.error(
      { error: (err as Error).message, accountId, headcount, tierKey: tier.tier_key },
      'subscription-items: failed to update platform fee quantity in Stripe',
    );
  }
}

// ── updateAgentQuantity ────────────────────────────────────────────────────────

export async function updateAgentQuantity(accountId: string): Promise<void> {
  const pool = getPool();

  // Find the 'agent' subscription item for this account
  const itemRow = await pool.query<{ stripe_subscription_item_id: string }>(
    `SELECT stripe_subscription_item_id FROM subscription_items
     WHERE account_id = $1 AND item_type = 'agent'
     LIMIT 1`,
    [accountId],
  );
  if (itemRow.rows.length === 0) {
    // Subscription not yet set up or sync hasn't run — nothing to update
    return;
  }
  const itemId = itemRow.rows[0].stripe_subscription_item_id;

  // Count active internal agents across all tenants belonging to this account
  const countRow = await withAdminScope({ caller: 'billing.subscription-items-service', reason: 'count active internal_agents across all tenants of an account (by account_id)' }, (client) => client.query<{ count: string }>(
    `SELECT COUNT(*) AS count
     FROM internal_agents ia
     JOIN tenants t ON t.id = ia.tenant_id
     WHERE t.account_id = $1
       AND ia.status = 'active'
       AND ia.deleted_at IS NULL`,
    [accountId],
  ));
  const quantity = parseInt(countRow.rows[0]?.count ?? '0', 10);

  try {
    const stripe = await getStripe();
    await stripe.subscriptionItems.update(itemId, { quantity });
    log.info({ accountId, quantity }, 'subscription-items: agent quantity updated');
  } catch (err) {
    // Non-fatal — Stripe may be temporarily unavailable; next status change will retry
    log.error(
      { error: (err as Error).message, accountId, quantity },
      'subscription-items: failed to update agent quantity in Stripe',
    );
  }
}
