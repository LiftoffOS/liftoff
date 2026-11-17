-- billing: RLS enablement on tenant-scoped tables (plan 0h).
-- Applied after schema migrations by the billing-migrate Cloud Run Job.
-- Policies use current_setting('app.current_tenant_id', false) so a missing
-- context is a hard error (not a silent no-match).

-- Tables that carry tenant_id and must enforce RLS.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'subscriptions',
    'subscription_items',
    'invoices',
    'invoice_line_items',
    'meter_events',
    'meter_reconciliation_log',
    'stripe_webhook_events',
    'payment_methods',
    'payment_method_audit',
    'billing_audit_log',
    'processed_events',
    'outbox_events'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      DROP POLICY IF EXISTS %I_tenant_isolation ON %I;
      CREATE POLICY %I_tenant_isolation ON %I
        USING (tenant_id = current_setting('app.current_tenant_id', false)::uuid)
        WITH CHECK (tenant_id = current_setting('app.current_tenant_id', false)::uuid);
    $f$, t, t, t, t);
  END LOOP;
END $$;

-- Global tables (plans, plan_features) are cross-tenant — RLS is NOT
-- enabled. Writes are restricted to billing_migrate at the role level.
-- Documented here so a future reader doesn't enable RLS by accident.
--   plans
--   plan_features
