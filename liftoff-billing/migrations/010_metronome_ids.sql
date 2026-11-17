-- migrations/010_metronome_ids.sql
-- Add Metronome customer/contract IDs to subscriptions, and a
-- metronome_invoice_id column to invoices for usage invoices created
-- by Metronome (which are still Stripe invoices — stripe_invoice_id
-- remains the primary key).

BEGIN;

ALTER TABLE subscriptions
  ADD COLUMN metronome_customer_id TEXT,
  ADD COLUMN metronome_contract_id  TEXT;

CREATE INDEX idx_subscriptions_metronome_customer
  ON subscriptions(metronome_customer_id)
  WHERE metronome_customer_id IS NOT NULL;

ALTER TABLE invoices
  ADD COLUMN metronome_invoice_id TEXT;

CREATE UNIQUE INDEX idx_invoices_metronome_id
  ON invoices(metronome_invoice_id)
  WHERE metronome_invoice_id IS NOT NULL;

COMMIT;
