-- Strip capacity cap columns from entitlements (no longer used — credits are the limiter)
ALTER TABLE entitlements
  DROP COLUMN IF EXISTS max_active_agents,
  DROP COLUMN IF EXISTS max_active_workflows,
  DROP COLUMN IF EXISTS max_actions_per_minute,
  DROP COLUMN IF EXISTS max_reflection_runs_per_day,
  DROP COLUMN IF EXISTS max_queued_tasks,
  DROP COLUMN IF EXISTS max_connector_writes_per_minute,
  DROP COLUMN IF EXISTS db_concurrency_budget,
  DROP COLUMN IF EXISTS max_reflection_runs_per_week,
  DROP COLUMN IF EXISTS max_scheduled_agents,
  DROP COLUMN IF EXISTS max_delegations_per_hour,
  DROP COLUMN IF EXISTS max_delegation_depth;

-- Make cap columns nullable in entitlement_snapshots (preserve historical data, stop writing new values)
ALTER TABLE entitlement_snapshots
  ALTER COLUMN max_active_agents SET DEFAULT 0,
  ALTER COLUMN max_active_agents DROP NOT NULL,
  ALTER COLUMN max_active_workflows SET DEFAULT 0,
  ALTER COLUMN max_active_workflows DROP NOT NULL,
  ALTER COLUMN max_actions_per_minute SET DEFAULT 0,
  ALTER COLUMN max_actions_per_minute DROP NOT NULL,
  ALTER COLUMN max_reflection_runs_per_day SET DEFAULT 0,
  ALTER COLUMN max_reflection_runs_per_day DROP NOT NULL,
  ALTER COLUMN max_queued_tasks SET DEFAULT 0,
  ALTER COLUMN max_queued_tasks DROP NOT NULL,
  ALTER COLUMN max_connector_writes_per_minute SET DEFAULT 0,
  ALTER COLUMN max_connector_writes_per_minute DROP NOT NULL,
  ALTER COLUMN db_concurrency_budget SET DEFAULT 0,
  ALTER COLUMN db_concurrency_budget DROP NOT NULL,
  ALTER COLUMN max_reflection_runs_per_week SET DEFAULT 0,
  ALTER COLUMN max_reflection_runs_per_week DROP NOT NULL,
  ALTER COLUMN max_scheduled_agents SET DEFAULT 0,
  ALTER COLUMN max_scheduled_agents DROP NOT NULL,
  ALTER COLUMN max_delegations_per_hour SET DEFAULT 0,
  ALTER COLUMN max_delegations_per_hour DROP NOT NULL,
  ALTER COLUMN max_delegation_depth SET DEFAULT 0,
  ALTER COLUMN max_delegation_depth DROP NOT NULL;

-- Drop cap columns from plans table
ALTER TABLE plans
  DROP COLUMN IF EXISTS max_active_agents,
  DROP COLUMN IF EXISTS max_active_workflows;
