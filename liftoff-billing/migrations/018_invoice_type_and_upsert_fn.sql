CREATE TYPE invoice_type AS ENUM ('subscription_cycle','prepaid_reload','threshold','recovery','unknown');

ALTER TABLE invoices
  ADD COLUMN type               invoice_type NOT NULL DEFAULT 'unknown',
  ADD COLUMN hosted_invoice_url TEXT,                 -- populated when Stripe finalizes the invoice
  ADD COLUMN invoice_pdf        TEXT;                 -- ditto

CREATE INDEX idx_invoices_tenant_type_issued
  ON invoices (tenant_id, type, issued_at DESC);

-- Superseded upsert function: adds p_type, p_hosted_invoice_url, p_invoice_pdf.
-- Hosted URL + PDF use COALESCE on UPDATE so a later webhook (e.g. invoice.finalized)
-- can fill them in after the initial invoice.created event left them NULL.
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
  p_invoice_pdf          TEXT         DEFAULT NULL
) RETURNS VOID
LANGUAGE SQL
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO invoices (id, tenant_id, stripe_invoice_id, status,
                        amount_due_cents, amount_paid_cents, tax_cents, currency,
                        period_start, period_end, issued_at, paid_at, type,
                        hosted_invoice_url, invoice_pdf)
  VALUES (gen_random_uuid(), p_tenant_id, p_stripe_invoice_id, p_status,
          p_amount_due_cents, p_amount_paid_cents, p_tax_cents, p_currency,
          to_timestamp(p_period_start), to_timestamp(p_period_end),
          to_timestamp(p_issued_at), p_paid_at, p_type,
          p_hosted_invoice_url, p_invoice_pdf)
  ON CONFLICT (stripe_invoice_id) DO UPDATE
    SET tenant_id          = EXCLUDED.tenant_id,
        status             = EXCLUDED.status,
        amount_due_cents   = EXCLUDED.amount_due_cents,
        amount_paid_cents  = EXCLUDED.amount_paid_cents,
        tax_cents          = EXCLUDED.tax_cents,
        paid_at            = EXCLUDED.paid_at,
        type               = EXCLUDED.type,
        hosted_invoice_url = COALESCE(EXCLUDED.hosted_invoice_url, invoices.hosted_invoice_url),
        invoice_pdf        = COALESCE(EXCLUDED.invoice_pdf,        invoices.invoice_pdf);
$$;
