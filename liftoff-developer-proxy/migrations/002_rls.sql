BEGIN;

ALTER TABLE byok_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE byok_usage_log   ENABLE ROW LEVEL SECURITY;

-- byok_credentials: tenant isolation for app queries.
-- Auth middleware reads by key_hash without tenant context — allowed by
-- the bypass policy below.
CREATE POLICY tenant_isolation ON byok_credentials
  FOR ALL
  USING (
    current_setting('app.current_byok_tenant_id', true) IS NOT NULL
    AND tenant_id = current_setting('app.current_byok_tenant_id', true)::uuid
  )
  WITH CHECK (
    current_setting('app.current_byok_tenant_id', true) IS NOT NULL
    AND tenant_id = current_setting('app.current_byok_tenant_id', true)::uuid
  );

-- Auth middleware bypass: SELECT when no tenant context bound (key lookup by hash)
CREATE POLICY auth_lookup_bypass ON byok_credentials
  FOR SELECT
  USING (current_setting('app.current_byok_tenant_id', true) IS NULL);

-- byok_usage_log: same dual-policy pattern as billing outbox
-- App writes with tenant context; background reporter reads without
CREATE POLICY tenant_isolation ON byok_usage_log
  USING (
    current_setting('app.current_byok_tenant_id', true) IS NOT NULL
    AND tenant_id = current_setting('app.current_byok_tenant_id', true)::uuid
  )
  WITH CHECK (
    current_setting('app.current_byok_tenant_id', true) IS NOT NULL
    AND tenant_id = current_setting('app.current_byok_tenant_id', true)::uuid
  );

CREATE POLICY reporter_bypass ON byok_usage_log
  FOR ALL
  USING (current_setting('app.current_byok_tenant_id', true) IS NULL)
  WITH CHECK (current_setting('app.current_byok_tenant_id', true) IS NULL);

-- outbox_events: publisher reads all tenants without context
ALTER TABLE outbox_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY tenant_isolation ON outbox_events
  FOR INSERT
  WITH CHECK (tenant_id = current_setting('app.current_byok_tenant_id', false)::uuid);

CREATE POLICY tenant_select ON outbox_events
  FOR SELECT
  USING (
    current_setting('app.current_byok_tenant_id', true) IS NOT NULL
    AND tenant_id = current_setting('app.current_byok_tenant_id', true)::uuid
  );

CREATE POLICY publisher_bypass ON outbox_events
  FOR ALL
  USING (current_setting('app.current_byok_tenant_id', true) IS NULL)
  WITH CHECK (current_setting('app.current_byok_tenant_id', true) IS NULL);

COMMIT;
