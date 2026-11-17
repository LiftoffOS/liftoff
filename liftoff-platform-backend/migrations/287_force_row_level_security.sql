-- Migration 287: FORCE ROW LEVEL SECURITY on all RLS-enabled tenant-scoped tables
--
-- The enforcement step of the RLS rollout. Postgres table
-- OWNERS bypass RLS unless FORCE is set; the app role (liftoff_app) owns (or, via
-- cloudsqlsuperuser membership, can act as owner of) the in-scope tables, so RLS is
-- ENABLED but NOT ENFORCING until this runs. This migration makes it enforce.
--
-- ┌─────────────────────────────────────────────────────────────────────────┐
-- │ HARD PREREQUISITE — both are satisfied before this migration deploys:     │
-- │  1. The admin pool connects as BYPASSRLS liftoff_admin: DB_ADMIN_USER=      │
-- │     liftoff_admin (terraform), liftoff_admin's DB password provisioned      │
-- │     equal to control-plane-db-password, startup probe admin_pool_probe_ok.  │
-- │  2. Every raw callsite on an RLS table is wrapped (withTenantScope /         │
-- │     withAdminScope / set_config-in-tx) — the rls(force-prep) commit series.  │
-- └─────────────────────────────────────────────────────────────────────────┘
--
-- Runs as liftoff_app, which is a member of cloudsqlsuperuser (INHERIT) and can
-- therefore ALTER every in-scope table (owned by liftoff_app OR cloudsqlsuperuser).
-- FORCE is idempotent.
--
-- Scope: every table with relrowsecurity = true. distillation_cache (migration
-- 200) and tool_classification_cache (migration 286) already have RLS DISABLED —
-- they are shared global caches and are intentionally out of scope.
--
-- Verify after applying:
--   TEST_DATABASE_URL=<db-url> npx jest --config jest.integration.config.js \
--     migrations/__tests__/200_verification.integration.test.ts

DO $$
DECLARE rec RECORD;
BEGIN
  FOR rec IN
    SELECT c.relname
    FROM pg_class c
    WHERE c.relkind IN ('r','p')
      AND c.relnamespace = 'public'::regnamespace
      AND c.relrowsecurity
      AND NOT c.relforcerowsecurity
    ORDER BY c.relname
  LOOP
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', rec.relname);
    RAISE NOTICE 'FORCE ROW LEVEL SECURITY: %', rec.relname;
  END LOOP;
END $$;
