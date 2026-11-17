-- migrations/014_subscriptions_plan_id_text.sql
-- Change subscriptions.plan_id from UUID FK to TEXT so that plan type strings
-- ('core', 'growth', 'scale', 'enterprise') can be stored directly.
-- The plans table FK was the initial design but was superseded by Stripe-native
-- plan handling where plan_type comes from subscription metadata, not a plans row.

BEGIN;

ALTER TABLE subscriptions
  DROP CONSTRAINT IF EXISTS subscriptions_plan_id_fkey,
  ALTER COLUMN plan_id TYPE TEXT USING plan_id::TEXT,
  ALTER COLUMN plan_id DROP NOT NULL;

COMMIT;
