-- Engine configuration and delegate agents for execution engine abstraction
-- Defaults ensure backwards compatibility: all existing agents get custom-loop

ALTER TABLE internal_agents ADD COLUMN IF NOT EXISTS
  engine_config JSONB NOT NULL DEFAULT '{"type":"custom-loop"}'::jsonb;
ALTER TABLE internal_agents ADD COLUMN IF NOT EXISTS
  delegates JSONB NOT NULL DEFAULT '[]'::jsonb;

ALTER TABLE internal_agent_versions ADD COLUMN IF NOT EXISTS
  engine_config JSONB NOT NULL DEFAULT '{"type":"custom-loop"}'::jsonb;
ALTER TABLE internal_agent_versions ADD COLUMN IF NOT EXISTS
  delegates JSONB NOT NULL DEFAULT '[]'::jsonb;

COMMENT ON COLUMN internal_agents.engine_config IS 'Execution engine config: {type, model?, endpoint?, transport?, auth?, budgetTokens?}';
COMMENT ON COLUMN internal_agents.delegates IS 'Delegate agent configs: [{alias, description, externalAgentId?, endpoint?, transport, auth?, tools?, categories?}]';
