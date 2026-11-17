-- Per-agent billing.
--
-- platform_fee_catalog  — tiered by company headcount; stripe_price_id set in Phase 5
-- subscription_items    — maps account → Stripe subscription line items; synced from
--                         customer.subscription.created/updated webhooks via liftoff-billing
-- stripe_usage_reports  — audit trail of every metered OU usage record sent to Stripe;
--                         stripe_idempotency_key is the dedup anchor (ON CONFLICT DO NOTHING)

-- ── Platform fee tier catalog ──────────────────────────────────────────────────

CREATE TABLE platform_fee_catalog (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier_key                  TEXT NOT NULL UNIQUE,
  name                      TEXT NOT NULL,
  min_headcount             INTEGER NOT NULL,
  max_headcount             INTEGER,                    -- NULL = unlimited
  price_per_headcount_cents INTEGER NOT NULL DEFAULT 0, -- $0 until pricing finalised (Phase 5)
  stripe_price_id           TEXT,                       -- one price per tier; quantity = company headcount
  active                    BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                TIMESTAMPTZ DEFAULT NOW()
);

-- platform fee = company headcount × price_per_headcount_cents for their tier
-- stripe subscription item quantity is set to the account's headcount; unit price = price_per_headcount_cents
INSERT INTO platform_fee_catalog (tier_key, name, min_headcount, max_headcount, price_per_headcount_cents, stripe_price_id) VALUES
  ('headcount_0_20',    'Starter (1–20)',      0,   20,  0, 'price_YOUR_STRIPE_ID'),
  ('headcount_20_100',  'Growth (21–100)',     21,  100,  0, 'price_YOUR_STRIPE_ID'),
  ('headcount_100_500', 'Scale (101–500)',    101,  500,  0, 'price_YOUR_STRIPE_ID'),
  ('headcount_500_plus','Enterprise (501+)',  501, NULL,  0, 'price_YOUR_STRIPE_ID');

-- ── Subscription items ─────────────────────────────────────────────────────────
-- Synced from Stripe on every customer.subscription.created/updated event.
-- item_type drives billing logic:
--   platform    — flat monthly platform fee
--   agent       — per-seat quantity (updated by agent deploy/undeploy hooks)
--   ou_overage  — metered usage; hourly cron reports delta OUs
--   addon       — optional feature add-ons (managed in Phase 4)

CREATE TABLE subscription_items (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                  UUID NOT NULL REFERENCES accounts(id),
  stripe_subscription_id      TEXT NOT NULL,
  stripe_subscription_item_id TEXT NOT NULL UNIQUE,
  item_type                   TEXT NOT NULL CHECK (item_type IN ('platform', 'agent', 'ou_overage', 'addon')),
  stripe_price_id             TEXT,
  quantity                    INTEGER NOT NULL DEFAULT 1,
  platform_fee_tier_key       TEXT REFERENCES platform_fee_catalog(tier_key),
  created_at                  TIMESTAMPTZ DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_subscription_items_account ON subscription_items (account_id);
CREATE INDEX idx_subscription_items_type    ON subscription_items (account_id, item_type);

-- ── Stripe usage reports ───────────────────────────────────────────────────────
-- One row per successful stripe.subscriptionItems.createUsageRecord() call.
-- stripe_idempotency_key is the conflict anchor — duplicate calls are silently
-- dropped (ON CONFLICT DO NOTHING), making the cron idempotent.

CREATE TABLE stripe_usage_reports (
  id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id                  UUID NOT NULL,
  stripe_subscription_item_id TEXT NOT NULL,
  reported_ous                INTEGER NOT NULL,
  period_start                TIMESTAMPTZ NOT NULL,
  reported_at                 TIMESTAMPTZ DEFAULT NOW(),
  stripe_idempotency_key      TEXT NOT NULL UNIQUE
);

CREATE INDEX idx_stripe_usage_reports_account ON stripe_usage_reports (account_id, period_start);

-- Index to speed up syncSubscriptionItems lookup: resolves account_id from subscriptionId.
-- Without this, every webhook fires a seqscan on billing_controls.
CREATE INDEX idx_billing_controls_stripe_sub ON billing_controls (stripe_subscription_id)
  WHERE stripe_subscription_id IS NOT NULL;

-- Company headcount stored on accounts — drives platform fee tier resolution and
-- Stripe subscription item quantity (quantity = headcount, unit_amount = price_per_headcount_cents).
-- Updated by CS via POST /api/internal/billing/accounts/:accountId/headcount.
ALTER TABLE accounts ADD COLUMN headcount INTEGER NOT NULL DEFAULT 0;
