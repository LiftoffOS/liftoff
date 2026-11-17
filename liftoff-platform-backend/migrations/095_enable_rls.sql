-- Migration 090: Enable Row-Level Security on all tenant-scoped tables
-- Phase 1 of tiered tenancy: logical data isolation via Postgres RLS
--
-- Strategy:
--   1. Add tenant_id to company_employees (denormalized, with sync trigger)
--   2. Enable RLS on every table that has a tenant_id column
--   3. Create tenant isolation policies (USING + WITH CHECK)
--   4. Do NOT add FORCE ROW LEVEL SECURITY yet (follow-up migration after validation)
--
-- Key design decisions:
--   - current_setting('app.current_tenant_id') WITHOUT the silent-null second param
--     so missing tenant context throws an error (fail loudly, not silently)
--   - SET LOCAL in withTenantScope() is transaction-scoped; RESET in finally for defense-in-depth
--   - Platform-global tables (accounts, plans, subscriptions, staff_roles, tenants,
--     invite_requests, feature_flags, passkeys) are excluded

-- ============================================================================
-- Step 0: Create liftoff_admin role with BYPASSRLS
-- Used by withAdminScope() for migrations, provisioning, operator dashboard,
-- billing aggregation, and cross-tenant queries.
-- ============================================================================

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'liftoff_admin') THEN
    CREATE ROLE liftoff_admin WITH LOGIN BYPASSRLS;
    RAISE NOTICE 'Created liftoff_admin role with BYPASSRLS';
  END IF;
END $$;

-- Grant the admin role access to the public schema and all tables
GRANT USAGE ON SCHEMA public TO liftoff_admin;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO liftoff_admin;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO liftoff_admin;

-- Ensure future tables also grant access to the admin role
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON TABLES TO liftoff_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL PRIVILEGES ON SEQUENCES TO liftoff_admin;

-- ============================================================================
-- Step 1: Denormalize tenant_id onto company_employees
-- ============================================================================

ALTER TABLE company_employees ADD COLUMN IF NOT EXISTS tenant_id UUID REFERENCES tenants(id);

UPDATE company_employees ce
SET tenant_id = cps.tenant_id
FROM company_payroll_settings cps
WHERE ce.company_payroll_id = cps.id
  AND ce.tenant_id IS NULL;

ALTER TABLE company_employees ALTER COLUMN tenant_id SET NOT NULL;

-- Sync trigger: keeps tenant_id in sync when company_payroll_id changes
CREATE OR REPLACE FUNCTION sync_employee_tenant_id() RETURNS TRIGGER AS $$
BEGIN
  NEW.tenant_id := (
    SELECT tenant_id FROM company_payroll_settings WHERE id = NEW.company_payroll_id
  );
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_sync_employee_tenant_id
  BEFORE INSERT OR UPDATE ON company_employees
  FOR EACH ROW EXECUTE FUNCTION sync_employee_tenant_id();

-- ============================================================================
-- Step 2: Enable RLS and create policies on all tenant-scoped tables
-- ============================================================================

-- Platform-global tables that should NOT get RLS
-- accounts, plans, subscriptions, staff_roles, tenants, invite_requests,
-- feature_flags, passkeys, schema_migrations, migration_jobs, migration_history

DO $$
DECLARE
  rec RECORD;
  policy_name TEXT;
  cast_expr TEXT;
  excluded_tables TEXT[] := ARRAY[
    'accounts', 'plans', 'subscriptions', 'staff_roles', 'tenants',
    'invite_requests', 'feature_flags', 'passkeys',
    'schema_migrations', 'migration_jobs', 'migration_history'
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
    policy_name := 'tenant_isolation_' || rec.table_name;

    -- Match the cast to the column's actual type.
    -- Most tables use UUID, but some legacy tables use TEXT/VARCHAR.
    IF rec.udt_name = 'uuid' THEN
      cast_expr := 'current_setting(''app.current_tenant_id'')::uuid';
    ELSE
      cast_expr := 'current_setting(''app.current_tenant_id'')::text';
    END IF;

    -- Enable RLS (idempotent — Postgres ignores if already enabled)
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', rec.table_name);

    -- Drop existing policy if any (for idempotent re-runs)
    EXECUTE format('DROP POLICY IF EXISTS %I ON %I', policy_name, rec.table_name);

    -- Create tenant isolation policy
    -- Uses current_setting WITHOUT the `true` param — errors on missing scope
    EXECUTE format(
      'CREATE POLICY %I ON %I
         USING (tenant_id = %s)
         WITH CHECK (tenant_id = %s)',
      policy_name, rec.table_name, cast_expr, cast_expr
    );

    RAISE NOTICE 'RLS enabled on % (tenant_id type: %)', rec.table_name, rec.udt_name;
  END LOOP;
END $$;

-- ============================================================================
-- Step 3: Add index on company_employees.tenant_id for RLS filter performance
-- ============================================================================

CREATE INDEX IF NOT EXISTS idx_company_employees_tenant_id
  ON company_employees(tenant_id);
