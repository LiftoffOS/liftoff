-- Migration 284: Exclude tool_classification_cache from RLS (content-table exclusion)
--
-- Part of the RLS FORCE-enforcement rollout.
--
-- tool_classification_cache is an overwhelmingly-GLOBAL shared cache: tenant_id
-- IS NULL for nearly every row (per-tenant overrides are rare). The
-- classifier (src/mcp/tool-classifier.ts) reads it in a normal request/execution
-- context and MUST see the global (tenant_id IS NULL) rows via its app-level
--   SELECT ... WHERE tool_name = $1 AND tenant_id IS NULL
-- fallback (with a WHERE tenant_id = $2 tenant-override lookup first).
--
-- Under FORCE ROW LEVEL SECURITY with the standard tenant-isolation policy
-- (tenant_id = current_setting('app.current_tenant_id')), those global NULL rows
-- would be invisible to any tenant scope, breaking classification for every tool.
--
-- Like distillation_cache (excluded in migration 200), the correct treatment for
-- a shared global cache is to EXCLUDE it from RLS entirely. The minimal per-tenant
-- override isolation is preserved by the classifier's explicit app-level tenant_id
-- WHERE clauses. This migration MUST run before the FORCE ROW LEVEL SECURITY
-- migration so the table is never force-enabled.

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_class
    WHERE relname = 'tool_classification_cache'
      AND relnamespace = 'public'::regnamespace
      AND relrowsecurity
  ) THEN
    -- Drop the tenant-isolation policy (created by the 095/200 DO-loop) and
    -- disable RLS. Both are idempotent.
    EXECUTE 'DROP POLICY IF EXISTS tenant_isolation_tool_classification_cache ON tool_classification_cache';
    EXECUTE 'ALTER TABLE tool_classification_cache DISABLE ROW LEVEL SECURITY';
    RAISE NOTICE 'Excluded tool_classification_cache from RLS (shared global cache; app-level tenant_id filtering preserved)';
  ELSE
    RAISE NOTICE 'tool_classification_cache already has RLS disabled — no-op';
  END IF;
END $$;
