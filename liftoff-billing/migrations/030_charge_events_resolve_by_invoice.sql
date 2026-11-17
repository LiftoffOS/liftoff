-- Three things, all in service of resolving a Stripe CHARGE event back to the
-- tenant whose invoice it paid.
--
-- charge.refunded, charge.dispute.* and radar.early_fraud_warning.created
-- carry no tenant_id anywhere: not in metadata, and not on the object, which
-- names a charge rather than an invoice. The webhook receiver seeds the outbox
-- envelope with a sentinel UUID, the consumer binds that sentinel as
-- app.current_tenant_id, and `invoices` is strict-RLS by deliberate design
-- (migration 029 left the five sensitive tables that way and said why). So
-- settlePrepaidCredit's `SELECT type FROM invoices` matches zero rows and
-- returns without clawing anything back, and amount_refunded_cents is never
-- written. Unit tests that mock the lookup cannot see this.
--
-- The fix is the shape migration 022 already uses for invoice events: one
-- SECURITY DEFINER function answering one question by one key. Owned by
-- billing_migrate (the table owner), so it runs outside RLS without opening a
-- cross-tenant lane on the table itself.

BEGIN;

CREATE OR REPLACE FUNCTION tenant_id_for_stripe_invoice(p_invoice_id TEXT)
RETURNS UUID
LANGUAGE SQL
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT tenant_id
  FROM invoices
  WHERE stripe_invoice_id = p_invoice_id
  LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION tenant_id_for_stripe_invoice(TEXT) TO billing_app;

-- The wallet credit for a MANUAL top-up now happens on invoice.paid.
--
-- The charge is confirmed in the customer's browser so the card's issuer can
-- authenticate it, which means nothing server-side is present when it
-- settles: this event is the only place that sees it. Stripe sends BOTH
-- invoice.paid and invoice.payment_succeeded for one payment, and Pub/Sub may
-- redeliver either, so the credit needs a mark of its own. Idempotency at the
-- webhook ingress does not cover it — those are two different Stripe events,
-- each with its own id.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS wallet_credited_at TIMESTAMPTZ NULL;

-- Which invoice's charge an early fraud warning named. Audit only: the hold it
-- places lives on platform-backend's billing_controls, because that is where
-- admission is decided.
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fraud_warning_at  TIMESTAMPTZ NULL;
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fraud_warning_ref TEXT        NULL;

COMMENT ON COLUMN invoices.wallet_credited_at IS
  'Set once, by the invoice.paid handler, when a manual top-up credits the wallet. Auto-reload invoices credit synchronously in /api/internal/auto-reload and never carry this.';
COMMENT ON COLUMN invoices.fraud_warning_at IS
  'When an issuer reported this invoice''s charge as fraud (radar.early_fraud_warning.created).';
COMMENT ON COLUMN invoices.fraud_warning_ref IS
  'The Stripe early fraud warning id (issfr_...).';

COMMIT;
