-- migrations/017_invoice_upsert_fn.sql
-- SECURITY DEFINER invoice upsert bypasses the RLS USING conflict between
-- invoice.created (sentinel tenant) and invoice.finalized/paid (real tenant).
-- Also corrects existing rows: ON CONFLICT updates tenant_id to the current
-- effective value, repairing any rows inserted with a random sentinel UUID.

BEGIN;

CREATE OR REPLACE FUNCTION upsert_invoice_record(
  p_tenant_id          UUID,
  p_stripe_invoice_id  TEXT,
  p_status             invoice_status,
  p_amount_due_cents   BIGINT,
  p_amount_paid_cents  BIGINT,
  p_tax_cents          BIGINT,
  p_currency           TEXT,
  p_period_start       DOUBLE PRECISION,
  p_period_end         DOUBLE PRECISION,
  p_issued_at          DOUBLE PRECISION,
  p_paid_at            TIMESTAMPTZ
) RETURNS VOID
LANGUAGE SQL
VOLATILE
SECURITY DEFINER
SET search_path = public
AS $$
  INSERT INTO invoices (
    id, tenant_id, stripe_invoice_id, status,
    amount_due_cents, amount_paid_cents, tax_cents,
    currency, period_start, period_end, issued_at, paid_at
  )
  VALUES (
    gen_random_uuid(), p_tenant_id, p_stripe_invoice_id, p_status,
    p_amount_due_cents, p_amount_paid_cents, p_tax_cents,
    p_currency,
    to_timestamp(p_period_start), to_timestamp(p_period_end),
    to_timestamp(p_issued_at), p_paid_at
  )
  ON CONFLICT (stripe_invoice_id) DO UPDATE
    SET tenant_id         = EXCLUDED.tenant_id,
        status            = EXCLUDED.status,
        amount_due_cents  = EXCLUDED.amount_due_cents,
        amount_paid_cents = EXCLUDED.amount_paid_cents,
        tax_cents         = EXCLUDED.tax_cents,
        paid_at           = EXCLUDED.paid_at;
$$;

GRANT EXECUTE ON FUNCTION upsert_invoice_record(UUID, TEXT, invoice_status, BIGINT, BIGINT, BIGINT, TEXT, DOUBLE PRECISION, DOUBLE PRECISION, DOUBLE PRECISION, TIMESTAMPTZ) TO billing_app;

COMMIT;
