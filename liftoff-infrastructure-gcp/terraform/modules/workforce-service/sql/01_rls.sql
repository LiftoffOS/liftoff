-- workforce: RLS on tenant-scoped tables (plan 0h).
DO $$
DECLARE
  t text;
  tables text[] := ARRAY[
    'hrbp_provisioning_requests',
    'caio_draft_sessions',
    'agent_assignments',
    'workforce_audit_log',
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
