-- developer_proxy: RLS enablement on tenant-scoped tables (plan 0h).
-- developer_proxy is keyed on (tenant_id, user_id) per plan 0h.
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'developer_proxy_credentials',
    'developer_proxy_usage_log',
    'developer_proxy_session_events',
    'vendor_reconciliation_log',
    'processed_events',
    'outbox_events'
  ];
BEGIN
  FOREACH t IN ARRAY tables LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($f$
      DROP POLICY IF EXISTS %I_tenant_user_isolation ON %I;
      CREATE POLICY %I_tenant_user_isolation ON %I
        USING (
          tenant_id = current_setting('app.current_tenant_id', false)::uuid
          AND (
            -- Tables without user_id skip the user check.
            NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = %L AND column_name = 'user_id'
            )
            OR user_id = current_setting('app.current_user_id', false)::uuid
          )
        )
        WITH CHECK (
          tenant_id = current_setting('app.current_tenant_id', false)::uuid
          AND (
            NOT EXISTS (
              SELECT 1 FROM information_schema.columns
              WHERE table_name = %L AND column_name = 'user_id'
            )
            OR user_id = current_setting('app.current_user_id', false)::uuid
          )
        );
    $f$, t, t, t, t, t, t);
  END LOOP;
END $$;
