-- migrations/006_stripe_customer_id.sql
-- Add stripe_customer_id to subscriptions so reconciliation can call the
-- Stripe meter-events API without a redundant API round-trip per event.
-- Populated by the stripe-event-processor webhook consumer on
-- subscription.created / subscription.updated.

BEGIN;

ALTER TABLE subscriptions
  ADD COLUMN IF NOT EXISTS stripe_customer_id TEXT;

CREATE INDEX IF NOT EXISTS idx_subscriptions_stripe_customer
  ON subscriptions(stripe_customer_id)
  WHERE stripe_customer_id IS NOT NULL;

COMMENT ON COLUMN subscriptions.stripe_customer_id IS
  'Stripe customer ID (cus_*) — denormalized from Stripe for reconciliation lookups';

COMMIT;
