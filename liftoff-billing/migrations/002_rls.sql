-- migrations/002_rls.sql
-- RLS policies on every tenant-scoped table. Policies read
-- `current_setting('app.current_tenant_id', false)` so a missing
-- binding is a hard error, not a silent no-match. The helper
-- `withTenantContext` in @liftoffos/database is the only supported
-- way to acquire a connection (static-analyzer `runRlsFence` enforces
-- this in CI).

BEGIN;

ALTER TABLE subscriptions        ENABLE ROW LEVEL SECURITY;
ALTER TABLE invoices             ENABLE ROW LEVEL SECURITY;
ALTER TABLE meter_events         ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_methods      ENABLE ROW LEVEL SECURITY;
ALTER TABLE payment_method_audit ENABLE ROW LEVEL SECURITY;
ALTER TABLE credit_balances      ENABLE ROW LEVEL SECURITY;
ALTER TABLE outbox_events        ENABLE ROW LEVEL SECURITY;
ALTER TABLE billing_audit_log    ENABLE ROW LEVEL SECURITY;

-- Generic tenant-scoped policy used by every table above.
-- `current_setting('app.current_tenant_id', false)` throws 22023 if
-- no context is bound.
DO $$ DECLARE t TEXT;
BEGIN
  FOR t IN SELECT unnest(ARRAY[
    'subscriptions','invoices','meter_events','payment_methods',
    'payment_method_audit','credit_balances','outbox_events',
    'billing_audit_log'
  ]) LOOP
    EXECUTE format(
      'CREATE POLICY tenant_isolation ON %I USING (tenant_id = current_setting(''app.current_tenant_id'', false)::uuid) WITH CHECK (tenant_id = current_setting(''app.current_tenant_id'', false)::uuid)',
      t
    );
  END LOOP;
END $$;

-- subscription_items / invoice_line_items / plan_features are scoped
-- through their parent's tenant_id; RLS inherits via join + subquery
-- in the policy.
ALTER TABLE subscription_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON subscription_items
  USING (subscription_id IN (
    SELECT id FROM subscriptions
    WHERE tenant_id = current_setting('app.current_tenant_id', false)::uuid
  ));

ALTER TABLE invoice_line_items ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON invoice_line_items
  USING (invoice_id IN (
    SELECT id FROM invoices
    WHERE tenant_id = current_setting('app.current_tenant_id', false)::uuid
  ));

-- plans / plan_features / stripe_webhook_events / processed_events /
-- meter_reconciliation_log are global — not tenant-scoped.

COMMIT;
