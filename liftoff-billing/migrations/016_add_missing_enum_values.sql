-- migrations/016_add_missing_enum_values.sql
-- Add missing enum values that Stripe uses but our schema was missing:
--   • subscription_status: 'incomplete_expired' (Stripe lifecycle state)
--   • invoice_status: 'finalized' (used internally by onInvoiceFinalized handler)

BEGIN;

ALTER TYPE subscription_status ADD VALUE IF NOT EXISTS 'incomplete_expired';
ALTER TYPE invoice_status ADD VALUE IF NOT EXISTS 'finalized';

COMMIT;
