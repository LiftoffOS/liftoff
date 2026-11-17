-- migrations/015_tenant_lookup_fn.sql
-- SECURITY DEFINER function for tenant lookup by Stripe customer ID.
--
-- Invoice Stripe events lack tenant_id in their metadata. When multiple
-- invoice events fire for the same Stripe invoice (invoice.created,
-- invoice.finalized, invoice.paid), each got a different random sentinel UUID
-- — causing ON CONFLICT DO UPDATE to fail RLS because the existing row's
-- tenant_id didn't match the current context.
--
-- This function resolves the tenant by querying subscriptions directly.
-- SECURITY DEFINER + owned by billing_migrate (table owner) → RLS not applied.

BEGIN;

CREATE OR REPLACE FUNCTION tenant_id_for_stripe_customer(p_customer_id TEXT)
RETURNS UUID
LANGUAGE SQL
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT tenant_id
  FROM subscriptions
  WHERE stripe_customer_id = p_customer_id
  ORDER BY updated_at DESC
  LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION tenant_id_for_stripe_customer(TEXT) TO billing_app;

COMMIT;
