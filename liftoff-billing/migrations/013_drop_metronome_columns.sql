-- migrations/013_drop_metronome_columns.sql
-- Remove obsolete Metronome integration columns from subscriptions and invoices.
--
-- Metronome (standalone SaaS at api.metronome.com) was replaced by
-- Stripe-native billing.meterEvents; these columns are no longer used.

BEGIN;

DROP INDEX IF EXISTS idx_subscriptions_metronome_customer;
DROP INDEX IF EXISTS idx_invoices_metronome_id;

ALTER TABLE subscriptions
  DROP COLUMN IF EXISTS metronome_customer_id,
  DROP COLUMN IF EXISTS metronome_contract_id;

ALTER TABLE invoices
  DROP COLUMN IF EXISTS metronome_invoice_id;

COMMIT;
