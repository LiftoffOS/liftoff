-- Migration 002: Cost attribution fields — schema/code alignment.
--
-- Adds the columns the TypeScript repository layer expects but that were
-- omitted from the first-pass schema (001). All new columns are NULLABLE so
-- existing rows (and partitioned child tables) require no backfill.
--
-- Tables affected:
--   actions              — add workflow/task/attribution/audit columns
--   usage_events         — rename `units` → `credits`, add attribution columns
--   compensation_actions — add original_action_id, workflow_id, task_id,
--                          compensation_data (code uses these names)
--   compensation_plans   — add reason, actions (code uses these names)
--   burn_state           — rename period/credits columns to match code expectations
--
-- Partitioned tables (actions, usage_events): ALTER TABLE on the parent
-- propagates to all partitions automatically in Postgres 12+. No need to
-- ALTER each partition separately.

-- ─── actions: add cost-attribution and audit columns ─────────────────

ALTER TABLE actions
  ADD COLUMN IF NOT EXISTS workflow_id             UUID,
  ADD COLUMN IF NOT EXISTS task_id                 UUID,
  ADD COLUMN IF NOT EXISTS connector               TEXT,
  ADD COLUMN IF NOT EXISTS entity_type             TEXT,
  ADD COLUMN IF NOT EXISTS action_type             TEXT,
  ADD COLUMN IF NOT EXISTS target_ref              TEXT,
  ADD COLUMN IF NOT EXISTS pre_action_snapshot     JSONB,
  ADD COLUMN IF NOT EXISTS trace_id               TEXT,
  ADD COLUMN IF NOT EXISTS instruction_version     TEXT,
  ADD COLUMN IF NOT EXISTS undo_support_mode       TEXT,
  ADD COLUMN IF NOT EXISTS conflict_resolution_mode TEXT,
  ADD COLUMN IF NOT EXISTS payload                 JSONB,
  ADD COLUMN IF NOT EXISTS external_response       JSONB,
  ADD COLUMN IF NOT EXISTS error                   TEXT,
  ADD COLUMN IF NOT EXISTS completed_at            TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS audit_log_id            UUID;

-- Attribution indexes on the partitioned actions table
CREATE INDEX IF NOT EXISTS idx_actions_agent
  ON actions (tenant_id, agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_actions_workflow
  ON actions (workflow_id)
  WHERE workflow_id IS NOT NULL;

-- ─── usage_events: rename units → credits, add attribution columns ───

-- Rename the column the code never used under the old name
ALTER TABLE usage_events
  RENAME COLUMN units TO credits;

ALTER TABLE usage_events
  ADD COLUMN IF NOT EXISTS agent_id      TEXT,
  ADD COLUMN IF NOT EXISTS workflow_id   UUID,
  ADD COLUMN IF NOT EXISTS action_id     UUID,
  ADD COLUMN IF NOT EXISTS task_id       UUID,
  ADD COLUMN IF NOT EXISTS connector     TEXT,
  ADD COLUMN IF NOT EXISTS entity_type   TEXT,
  ADD COLUMN IF NOT EXISTS metadata      JSONB;

-- Attribution indexes on the partitioned usage_events table
CREATE INDEX IF NOT EXISTS idx_usage_events_agent
  ON usage_events (tenant_id, agent_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_action
  ON usage_events (action_id)
  WHERE action_id IS NOT NULL;

-- ─── compensation_actions: add columns used by repository INSERTs ─────
-- The repository code INSERTs into (original_action_id, workflow_id,
-- task_id, compensation_type, compensation_data, status); the original
-- schema used `action_id` and `compensation_spec` for the same purposes.
-- We add the new names as additional nullable columns so both old and new
-- code paths work during any rolling deploy.

ALTER TABLE compensation_actions
  ADD COLUMN IF NOT EXISTS original_action_id UUID,
  ADD COLUMN IF NOT EXISTS workflow_id        UUID,
  ADD COLUMN IF NOT EXISTS task_id            UUID,
  ADD COLUMN IF NOT EXISTS compensation_data  JSONB;

CREATE INDEX IF NOT EXISTS idx_compensation_actions_workflow
  ON compensation_actions (workflow_id)
  WHERE workflow_id IS NOT NULL;

-- ─── compensation_plans: add columns used by repository INSERTs ───────
-- The repository code INSERTs (workflow_id, reason, actions, status).
-- Original schema had `plan_payload` (not `actions`) and no `reason`.

ALTER TABLE compensation_plans
  ADD COLUMN IF NOT EXISTS reason  TEXT,
  ADD COLUMN IF NOT EXISTS actions JSONB;

-- ─── burn_state: rename columns to match code expectations ───────────
--
-- Current schema        →  Code expects
-- -------------------------------------------------
-- period_start DATE     →  billing_period_start DATE
-- credits_used          →  used_credits
-- credits_remaining     →  remaining_credits
-- updated_at            →  last_updated
-- (missing)             →  billing_period_end DATE
-- (missing)             →  included_credits NUMERIC(18,6)
-- (missing)             →  overage_credits  NUMERIC(18,6)

ALTER TABLE burn_state
  RENAME COLUMN period_start       TO billing_period_start;

ALTER TABLE burn_state
  RENAME COLUMN credits_used       TO used_credits;

ALTER TABLE burn_state
  RENAME COLUMN credits_remaining  TO remaining_credits;

ALTER TABLE burn_state
  RENAME COLUMN updated_at         TO last_updated;

ALTER TABLE burn_state
  ADD COLUMN IF NOT EXISTS billing_period_end DATE,
  ADD COLUMN IF NOT EXISTS included_credits   NUMERIC(18, 6) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS overage_credits    NUMERIC(18, 6) NOT NULL DEFAULT 0;

-- Re-create the updated_at trigger under the new column name.
-- The trigger function (set_updated_at) already exists from migration 001.
DROP TRIGGER IF EXISTS burn_state_updated_at ON burn_state;

CREATE TRIGGER burn_state_updated_at
  BEFORE UPDATE ON burn_state
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
