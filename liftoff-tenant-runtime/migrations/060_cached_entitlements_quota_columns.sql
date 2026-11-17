-- Finish the cached_entitlements schema migration started by 011_schema_fixes.sql.
--
-- 001_initial_schema.sql declared `data JSONB NOT NULL` to hold the full
-- entitlement payload as one blob. 011_schema_fixes.sql later split the basic
-- fields into individual typed columns (operational_status, agent_execution_allowed,
-- remaining_credits, max_active_*, max_actions_per_minute, max_reflection_runs_per_day)
-- but never:
--
--   1. Added the OTHER quota columns the runtime needs
--      (max_queued_tasks, max_connector_writes_per_minute, db_concurrency_budget,
--       included_monthly_credits, overage_ceiling, max_reflection_runs_per_week).
--      The runtime read these from `ce.data->>'maxQueuedTasks'` etc. via COALESCE
--      fallbacks in admission/dynamic-quota-service.ts.
--
--   2. Dropped or relaxed the original `data NOT NULL` column.
--      All current writers (entitlements-client, events/subscriber) populate
--      the individual columns and OMIT `data`. That violated NOT NULL with
--      Postgres error 23502, so every entitlement refresh from the control
--      plane silently failed. The cache stayed empty. The entitlements client
--      fell back to DEFAULT_TENANT_QUOTAS (agentExecutionAllowed=false). The
--      kill-switch middleware then blocked every tenant-scoped request with
--      HTTP 503 — including the new /api/tasks/agent-scheduled worker
--      endpoint after the Cloud Tasks migration.
--
-- This migration:
--   - Adds the missing per-tenant quota columns so the runtime has a single
--     source of truth (no more JSON fallback).
--   - Drops the legacy `data` column entirely. The matching code change
--     replaces the `ce.data->>...` reads in dynamic-quota-service.ts with
--     reads from the new columns and removes the dead updateCachedEntitlement
--     writer in tenant-api/repository.ts (only writer of `data`, no callers).
--
-- After this, the entitlement refresh path no longer 23502s, the kill-switch
-- gets correct values, and per-tenant quotas are properly honored instead of
-- silently falling through to hardcoded defaults.

-- One ALTER per statement: the in-tree migration schema validator
-- (handlers/__tests__/scheduled-invoke-schema-validation.test.ts) uses a
-- regex that only matches the first ADD COLUMN per ALTER TABLE, so a
-- comma-separated multi-column form would silently hide later columns
-- from the validator. Keep these split until that test grows real SQL parsing.
ALTER TABLE cached_entitlements ADD COLUMN IF NOT EXISTS max_queued_tasks INTEGER NOT NULL DEFAULT 100;
ALTER TABLE cached_entitlements ADD COLUMN IF NOT EXISTS max_connector_writes_per_minute INTEGER NOT NULL DEFAULT 30;
ALTER TABLE cached_entitlements ADD COLUMN IF NOT EXISTS db_concurrency_budget INTEGER NOT NULL DEFAULT 5;
ALTER TABLE cached_entitlements ADD COLUMN IF NOT EXISTS included_monthly_credits INTEGER NOT NULL DEFAULT 1000;
ALTER TABLE cached_entitlements ADD COLUMN IF NOT EXISTS overage_ceiling INTEGER NOT NULL DEFAULT 0;
ALTER TABLE cached_entitlements ADD COLUMN IF NOT EXISTS max_reflection_runs_per_week INTEGER NOT NULL DEFAULT 5;

ALTER TABLE cached_entitlements DROP COLUMN IF EXISTS data;
