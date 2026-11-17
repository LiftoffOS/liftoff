-- Migration 079: Enable Row-Level Security on all tenant-scoped tables
-- (Renumbered from 077 → 079: 078 was deployed first; node-pg-migrate
--  requires monotonic ordering against the pgmigrations table.)
-- Matches Phase 1 RLS from platform-backend (migration 095).
--
-- Strategy:
--   1. Upgrade existing RLS policies (audit_logs, connector_manifests) to fail-loud
--   2. Enable RLS on every remaining table with a tenant_id column
--   3. Create tenant isolation policies (USING + WITH CHECK)
--   4. Do NOT add FORCE ROW LEVEL SECURITY yet (follow-up after validation)
--
-- Key design decisions:
--   - Uses `app.tenant_id` (matches existing tenant-runtime convention from migrations 016/017)
--   - current_setting WITHOUT the `true` second parameter: missing tenant context
--     throws a Postgres error instead of silently returning empty. Fail loudly.
--   - Platform-backend uses `app.current_tenant_id`; tenant-runtime uses `app.tenant_id`.
--     Each DB has its own session variable name to avoid confusion across repos.

-- ============================================================================
-- Step 1: Upgrade existing policies to fail-loud (drop silent `true` param)
-- ============================================================================

-- audit_logs: replace silent policy with fail-loud
DROP POLICY IF EXISTS audit_logs_tenant_isolation ON audit_logs;
CREATE POLICY audit_logs_tenant_isolation ON audit_logs
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

-- connector_manifests: replace silent policy with fail-loud
DROP POLICY IF EXISTS connector_manifests_tenant_isolation ON connector_manifests;
CREATE POLICY connector_manifests_tenant_isolation ON connector_manifests
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);

-- ============================================================================
-- Step 2: Enable RLS on all remaining tenant-scoped tables
-- ============================================================================

-- Tables WITHOUT RLS (platform-global or system):
--   tenants, model_pricing_history, pgmigrations, compiled_instructions,
--   reflection_pattern_weights

DO $$
DECLARE
  rec RECORD;
  policy_name TEXT;
  cast_expr TEXT;
  excluded_tables TEXT[] := ARRAY[
    'tenants',
    'model_pricing_history',
    'pgmigrations',
    'compiled_instructions',
    'reflection_pattern_weights'
  ];
BEGIN
  FOR rec IN
    SELECT c.table_name, c.data_type, c.udt_name
    FROM information_schema.columns c
    JOIN information_schema.tables t
      ON t.table_name = c.table_name AND t.table_schema = c.table_schema
    WHERE c.column_name = 'tenant_id'
      AND c.table_schema = 'public'
      AND t.table_type = 'BASE TABLE'
      AND c.table_name != ALL(excluded_tables)
    ORDER BY c.table_name
  LOOP
    policy_name := rec.table_name || '_tenant_isolation';

    -- Match the cast to the column's actual type.
    -- Most tables use UUID, but some legacy tables use TEXT/VARCHAR.
    IF rec.udt_name = 'uuid' THEN
      cast_expr := 'current_setting(''app.tenant_id'')::uuid';
    ELSE
      cast_expr := 'current_setting(''app.tenant_id'')::text';
    END IF;

    -- Enable RLS (idempotent)
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', rec.table_name);

    -- Drop existing policy if any (for idempotent re-runs)
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_name, rec.table_name);

    -- Create tenant isolation policy — fail-loud on missing context
    EXECUTE format(
      'CREATE POLICY %I ON %I
         USING (tenant_id = %s)
         WITH CHECK (tenant_id = %s)',
      policy_name, rec.table_name, cast_expr, cast_expr
    );

    RAISE NOTICE 'RLS enabled on % (tenant_id type: %)', rec.table_name, rec.udt_name;
  END LOOP;
END $$;
