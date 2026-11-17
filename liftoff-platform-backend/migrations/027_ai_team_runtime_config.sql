-- AI Team Runtime Configuration
-- Per implementation plan: Enhanced AI Team Schema (with Version Tracking)
-- Adds runtime config columns to ai_teams and ai_team_versions tables

-- Add runtime config columns to ai_teams (main table)
ALTER TABLE ai_teams ADD COLUMN IF NOT EXISTS
  agent_type VARCHAR(20) NOT NULL DEFAULT 'B'
    CHECK (agent_type IN ('A', 'B', 'C'));

ALTER TABLE ai_teams ADD COLUMN IF NOT EXISTS
  hitl_level INTEGER CHECK (hitl_level IS NULL OR hitl_level BETWEEN 1 AND 5);

ALTER TABLE ai_teams ADD COLUMN IF NOT EXISTS
  model_config JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE ai_teams ADD COLUMN IF NOT EXISTS
  memory_scope JSONB NOT NULL DEFAULT '{"readable_layers": ["global", "individual"], "writable_layers": ["individual"]}'::jsonb;

ALTER TABLE ai_teams ADD COLUMN IF NOT EXISTS
  exec_config JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE ai_teams ADD COLUMN IF NOT EXISTS
  workflow_steps JSONB;

ALTER TABLE ai_teams ADD COLUMN IF NOT EXISTS
  trigger_config JSONB;

-- CRITICAL: Add same columns to ai_team_versions for snapshot tracking
-- (follows existing pattern where versions table mirrors main table)
ALTER TABLE ai_team_versions ADD COLUMN IF NOT EXISTS
  agent_type VARCHAR(20) NOT NULL DEFAULT 'B';

ALTER TABLE ai_team_versions ADD COLUMN IF NOT EXISTS
  hitl_level INTEGER;

ALTER TABLE ai_team_versions ADD COLUMN IF NOT EXISTS
  model_config JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE ai_team_versions ADD COLUMN IF NOT EXISTS
  memory_scope JSONB NOT NULL DEFAULT '{"readable_layers": ["global", "individual"], "writable_layers": ["individual"]}'::jsonb;

ALTER TABLE ai_team_versions ADD COLUMN IF NOT EXISTS
  exec_config JSONB NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE ai_team_versions ADD COLUMN IF NOT EXISTS
  workflow_steps JSONB;

ALTER TABLE ai_team_versions ADD COLUMN IF NOT EXISTS
  trigger_config JSONB;

-- Comments for documentation
COMMENT ON COLUMN ai_teams.agent_type IS 'A=Manager (conversational), B=IC (task executor), C=Single-task (scheduled)';
COMMENT ON COLUMN ai_teams.hitl_level IS 'Per-team override. NULL = use tenant default. 1=Full approval, 2=Destructive only, 3=Balanced, 4=Autonomous checkpoints, 5=Fully autonomous';
COMMENT ON COLUMN ai_teams.model_config IS '{ model_id, max_tokens, temperature }';
COMMENT ON COLUMN ai_teams.memory_scope IS '{ readable_layers: [], writable_layers: [], scope_keys: [] }';
COMMENT ON COLUMN ai_teams.exec_config IS '{ max_tool_calls, timeout_ms, hitl_checkpoints: [] }';
COMMENT ON COLUMN ai_teams.workflow_steps IS 'Type C only: [{ step_id, description, tool_name?, condition?, on_success?, on_failure? }]';
COMMENT ON COLUMN ai_teams.trigger_config IS 'Type C only: { type: cron|event, cron_expr?, event_topic? }';
