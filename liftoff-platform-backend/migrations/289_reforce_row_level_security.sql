-- Migration 289: (re-)FORCE ROW LEVEL SECURITY on all RLS-enabled tenant tables
--
-- Durable re-application of migration 287. FORCE only holds once every
-- tenant-scoped callsite runs inside a tenant scope: raw tenant-scoped
-- pool.query callsites, variable-built SQL that hides tables from a
-- line-level census, and dynamic table-name queries (FROM ${table}) all break
-- under it. All are wrapped (withTenantScope / withAdminScope /
-- set_config-in-tx), and migration 288 grants liftoff_admin future-table access.
--
-- Because 287 is already recorded in schema_migrations it will not re-run, so
-- this migration re-applies FORCE. It is idempotent: the DO-loop only touches
-- tables that are RLS-enabled but not yet FORCEd. Deploy the wrapped code before
-- applying it, so there is no deploy-window error gap; this migration makes FORCE
-- durable for any freshly built / disaster-recovery-restored database.
--
-- Runs as liftoff_app (member of cloudsqlsuperuser, INHERIT) so it can ALTER
-- every in-scope table. distillation_cache (200) and tool_classification_cache
-- (286) are RLS-DISABLED shared global caches — intentionally out of scope.

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
