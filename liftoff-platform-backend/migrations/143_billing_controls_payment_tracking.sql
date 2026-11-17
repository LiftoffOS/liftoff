-- Phase 0 gap fixes: threshold charge tracking and payment method flag

ALTER TABLE billing_controls
  ADD COLUMN threshold_charges_collected_usd NUMERIC(18,6) NOT NULL DEFAULT 0,
  ADD COLUMN has_payment_method              BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN billing_controls.threshold_charges_collected_usd IS
  'Running total of threshold charges collected this period. Reset to 0 on period-reset. Used by liftoff-billing to create a negative InvoiceItem on subscription_cycle invoices to prevent double-charging.';

COMMENT ON COLUMN billing_controls.has_payment_method IS
  'TRUE once a payment method has been attached via payment_method.attached/updated webhook. Guards against activating agents before a card is on file.';
