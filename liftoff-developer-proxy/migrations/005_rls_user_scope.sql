-- migrations/005_rls_user_scope.sql
-- Strengthen RLS to enforce (tenant_id, user_id) isolation on byok_credentials
-- and byok_usage_log. The plan requires "co-tenant user cannot read another
-- co-tenant user's credential or usage."
--
-- Policy hierarchy:
--   user_isolation   — both GUCs set → user-scoped (normal app writes/reads)
--   tenant_admin     — only tenant GUC set → tenant-level admin (list-all, billing)
--   auth_lookup_bypass / reporter_bypass — neither GUC → background processes

BEGIN;

-- ── byok_credentials ────────────────────────────────────────────────────────

DROP POLICY IF EXISTS tenant_isolation  ON byok_credentials;
DROP POLICY IF EXISTS auth_lookup_bypass ON byok_credentials;

-- Normal app: both tenant and user GUCs set
CREATE POLICY user_isolation ON byok_credentials
  USING (
    current_setting('app.current_byok_tenant_id', true) IS NOT NULL
    AND tenant_id = current_setting('app.current_byok_tenant_id', true)::uuid
    AND current_setting('app.current_byok_user_id', true) IS NOT NULL
    AND current_setting('app.current_byok_user_id', true) <> ''
    AND user_id = current_setting('app.current_byok_user_id', true)
  )
  WITH CHECK (
    current_setting('app.current_byok_tenant_id', true) IS NOT NULL
    AND tenant_id = current_setting('app.current_byok_tenant_id', true)::uuid
    AND current_setting('app.current_byok_user_id', true) IS NOT NULL
    AND current_setting('app.current_byok_user_id', true) <> ''
    AND user_id = current_setting('app.current_byok_user_id', true)
  );

-- Admin / billing: tenant GUC set, user GUC absent (list-all, revoke-for-tenant)
CREATE POLICY tenant_admin ON byok_credentials
  USING (
    current_setting('app.current_byok_tenant_id', true) IS NOT NULL
    AND tenant_id = current_setting('app.current_byok_tenant_id', true)::uuid
    AND (
      current_setting('app.current_byok_user_id', true) IS NULL
      OR current_setting('app.current_byok_user_id', true) = ''
    )
  )
  WITH CHECK (
    current_setting('app.current_byok_tenant_id', true) IS NOT NULL
    AND tenant_id = current_setting('app.current_byok_tenant_id', true)::uuid
    AND (
      current_setting('app.current_byok_user_id', true) IS NULL
      OR current_setting('app.current_byok_user_id', true) = ''
    )
  );

-- Auth middleware: no tenant context (key-hash lookup)
CREATE POLICY auth_lookup_bypass ON byok_credentials
  FOR SELECT
  USING (
    current_setting('app.current_byok_tenant_id', true) IS NULL
    OR current_setting('app.current_byok_tenant_id', true) = ''
  );

-- ── byok_usage_log ───────────────────────────────────────────────────────────

DROP POLICY IF EXISTS tenant_isolation ON byok_usage_log;
DROP POLICY IF EXISTS reporter_bypass  ON byok_usage_log;

-- Normal app: user-scoped reads/writes
CREATE POLICY user_isolation ON byok_usage_log
  USING (
    current_setting('app.current_byok_tenant_id', true) IS NOT NULL
    AND tenant_id = current_setting('app.current_byok_tenant_id', true)::uuid
    AND current_setting('app.current_byok_user_id', true) IS NOT NULL
    AND current_setting('app.current_byok_user_id', true) <> ''
    AND user_id = current_setting('app.current_byok_user_id', true)
  )
  WITH CHECK (
    current_setting('app.current_byok_tenant_id', true) IS NOT NULL
    AND tenant_id = current_setting('app.current_byok_tenant_id', true)::uuid
    AND current_setting('app.current_byok_user_id', true) IS NOT NULL
    AND current_setting('app.current_byok_user_id', true) <> ''
    AND user_id = current_setting('app.current_byok_user_id', true)
  );

-- Admin / billing: tenant-scoped aggregates (usage reporting)
CREATE POLICY tenant_admin ON byok_usage_log
  USING (
    current_setting('app.current_byok_tenant_id', true) IS NOT NULL
    AND tenant_id = current_setting('app.current_byok_tenant_id', true)::uuid
    AND (
      current_setting('app.current_byok_user_id', true) IS NULL
      OR current_setting('app.current_byok_user_id', true) = ''
    )
  )
  WITH CHECK (
    current_setting('app.current_byok_tenant_id', true) IS NOT NULL
    AND tenant_id = current_setting('app.current_byok_tenant_id', true)::uuid
    AND (
      current_setting('app.current_byok_user_id', true) IS NULL
      OR current_setting('app.current_byok_user_id', true) = ''
    )
  );

-- Handler / outbox publisher: no tenant context (direct usage writes, polling)
CREATE POLICY reporter_bypass ON byok_usage_log
  FOR ALL
  USING (
    current_setting('app.current_byok_tenant_id', true) IS NULL
    OR current_setting('app.current_byok_tenant_id', true) = ''
  )
  WITH CHECK (
    current_setting('app.current_byok_tenant_id', true) IS NULL
    OR current_setting('app.current_byok_tenant_id', true) = ''
  );

-- ── outbox_events tenant_isolation: tighten INSERT to use missing_ok=true ───
-- The current missing_ok=false crashes if GUC not set; reporter_bypass covers
-- the publisher path, but the INSERT policy must not require strict GUC.

DROP POLICY IF EXISTS tenant_isolation ON outbox_events;

CREATE POLICY tenant_isolation ON outbox_events
  FOR INSERT
  WITH CHECK (
    current_setting('app.current_byok_tenant_id', true) IS NULL
    OR current_setting('app.current_byok_tenant_id', true) = ''
    OR tenant_id = current_setting('app.current_byok_tenant_id', true)::uuid
  );

COMMIT;
