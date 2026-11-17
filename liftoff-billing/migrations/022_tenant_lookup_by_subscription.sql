-- migrations/022_tenant_lookup_by_subscription.sql
-- SECURITY DEFINER lookup of tenant by Stripe SUBSCRIPTION id.
--
-- Invoice Stripe events lack tenant_id in their metadata. They were previously
-- resolved via tenant_id_for_stripe_customer() (migration 015), which returns
-- the customer's MOST-RECENTLY-UPDATED subscription's tenant. That is wrong
-- across account lifecycles: deleting an account hard-deletes its tenant and a
-- re-signup creates a brand-new tenant_id while REUSING the same Stripe
-- customer. A customer-based lookup therefore attributes a prior life's invoice
-- to the current life's tenant (cross-life leak).
--
-- This function attributes an invoice by the subscription that generated it,
-- which carries a stable tenant_id for that account's whole life. Subscription
-- rows persist after cancellation/deletion (status='canceled'), so historical
-- invoices still resolve to their correct (possibly deleted) tenant.
--
-- SECURITY DEFINER + owned by billing_migrate (table owner) → RLS not applied,
-- mirroring tenant_id_for_stripe_customer.

BEGIN;

CREATE OR REPLACE FUNCTION tenant_id_for_stripe_subscription(p_subscription_id TEXT)
RETURNS UUID
LANGUAGE SQL
SECURITY DEFINER
STABLE
SET search_path = public
AS $$
  SELECT tenant_id
  FROM subscriptions
  WHERE stripe_subscription_id = p_subscription_id
  LIMIT 1
$$;

GRANT EXECUTE ON FUNCTION tenant_id_for_stripe_subscription(TEXT) TO billing_app;

COMMIT;
