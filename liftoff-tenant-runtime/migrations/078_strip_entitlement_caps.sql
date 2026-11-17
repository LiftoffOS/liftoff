-- Entitlements rework: strip capacity cap columns from cached_entitlements.
-- Credits are the only limiter; all max* capacity checks removed from admission.

-- Strip capacity cap columns from cached_entitlements
ALTER TABLE cached_entitlements
  DROP COLUMN IF EXISTS max_active_agents,
  DROP COLUMN IF EXISTS max_active_workflows,
  DROP COLUMN IF EXISTS max_actions_per_minute,
  DROP COLUMN IF EXISTS max_reflection_runs_per_day,
  DROP COLUMN IF EXISTS max_queued_tasks,
  DROP COLUMN IF EXISTS max_connector_writes_per_minute,
  DROP COLUMN IF EXISTS db_concurrency_budget,
  DROP COLUMN IF EXISTS max_reflection_runs_per_week;

-- Drop agent quotas table entirely
DROP TABLE IF EXISTS cached_agent_quotas;

-- Drop effective quotas table (no longer needed)
DROP TABLE IF EXISTS effective_quotas;

-- Rename quota_adjustments for ops incident response
ALTER TABLE IF EXISTS quota_adjustments RENAME TO tenant_operational_overrides;
