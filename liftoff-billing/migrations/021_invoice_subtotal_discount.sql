-- 021_invoice_subtotal_discount.sql
--
-- Surface the real economic content of an invoice on the local row.
-- Previously `amount_due_cents` was the only signal, but it's $0 whenever a
-- promo zeros out the first invoice — making a legitimate
-- $20-subtotal − $20-promo first month indistinguishable from a phantom $0/$0
-- Stripe artifact (e.g. the auto-provisioned sub's empty subscription_create
-- invoice). `subtotal_cents` and `discount_cents` come straight from Stripe's
-- `Invoice.subtotal` and the sum of `Invoice.total_discount_amounts[].amount`.
--
-- /invoices filters on subtotal > 0 OR discount > 0 OR amount_due > 0, so
-- $20-→-$0-via-promo rows surface (subtotal > 0) but phantom $0/$0/$0 rows
-- stay hidden. Backfill of pre-migration rows is handled by
-- scripts/backfill-invoice-subtotals.ts (calls Stripe per row — can't be done
-- inside a migration).

ALTER TABLE invoices
  ADD COLUMN subtotal_cents BIGINT NOT NULL DEFAULT 0,
  ADD COLUMN discount_cents BIGINT NOT NULL DEFAULT 0;

-- Superseded upsert function: adds p_subtotal_cents + p_discount_cents.
-- Other args unchanged from the v018 signature so call sites add the new
-- params at the end. ON CONFLICT writes EXCLUDED for both — webhooks
-- (invoice.created/finalized/paid) fire in sequence and each event's
-- subtotal/discount reflects the current state of the invoice, so the
-- latest write wins.
CREATE OR REPLACE FUNCTION upsert_invoice_record(
  p_tenant_id            UUID,
  p_stripe_invoice_id    TEXT,
  p_status               invoice_status,
  p_amount_due_cents     BIGINT,
  p_amount_paid_cents    BIGINT,
  p_tax_cents            BIGINT,
  p_currency             TEXT,
  p_period_start         DOUBLE PRECISION,
  p_period_end           DOUBLE PRECISION,
  p_issued_at            DOUBLE PRECISION,
  p_paid_at              TIMESTAMPTZ,
  p_type                 invoice_type DEFAULT 'unknown',
  p_hosted_invoice_url   TEXT         DEFAULT NULL,
  p_invoice_pdf          TEXT         DEFAULT NULL,
  p_subtotal_cents       BIGINT       DEFAULT 0,
  p_discount_cents       BIGINT       DEFAULT 0
) RETURNS VOID
LANGUAGE SQL
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO invoices (id, tenant_id, stripe_invoice_id, status,
                        amount_due_cents, amount_paid_cents, tax_cents, currency,
                        period_start, period_end, issued_at, paid_at, type,
                        hosted_invoice_url, invoice_pdf,
                        subtotal_cents, discount_cents)
  VALUES (gen_random_uuid(), p_tenant_id, p_stripe_invoice_id, p_status,
          p_amount_due_cents, p_amount_paid_cents, p_tax_cents, p_currency,
          to_timestamp(p_period_start), to_timestamp(p_period_end),
          to_timestamp(p_issued_at), p_paid_at, p_type,
          p_hosted_invoice_url, p_invoice_pdf,
          p_subtotal_cents, p_discount_cents)
  ON CONFLICT (stripe_invoice_id) DO UPDATE
    SET tenant_id          = EXCLUDED.tenant_id,
        status             = EXCLUDED.status,
        amount_due_cents   = EXCLUDED.amount_due_cents,
        amount_paid_cents  = EXCLUDED.amount_paid_cents,
        tax_cents          = EXCLUDED.tax_cents,
        paid_at            = EXCLUDED.paid_at,
        type               = EXCLUDED.type,
        hosted_invoice_url = COALESCE(EXCLUDED.hosted_invoice_url, invoices.hosted_invoice_url),
        invoice_pdf        = COALESCE(EXCLUDED.invoice_pdf,        invoices.invoice_pdf),
        subtotal_cents     = EXCLUDED.subtotal_cents,
        discount_cents     = EXCLUDED.discount_cents;
$$;
