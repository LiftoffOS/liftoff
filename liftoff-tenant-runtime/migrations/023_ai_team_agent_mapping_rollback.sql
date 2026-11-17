-- Rollback: 023_ai_team_agent_mapping_rollback.sql
BEGIN;

DROP TABLE IF EXISTS ai_team_agent_mapping;

ALTER TABLE agents DROP COLUMN IF EXISTS agent_type;
ALTER TABLE agents DROP COLUMN IF EXISTS hitl_level;
ALTER TABLE agents DROP COLUMN IF EXISTS model_config;
ALTER TABLE agents DROP COLUMN IF EXISTS exec_config;
ALTER TABLE agents DROP COLUMN IF EXISTS memory_scope;
ALTER TABLE agents DROP COLUMN IF EXISTS trigger_config;
ALTER TABLE agents DROP COLUMN IF EXISTS entity_version;
ALTER TABLE agents DROP COLUMN IF EXISTS system_prompt;
ALTER TABLE agents DROP COLUMN IF EXISTS user_instructions;

COMMIT;
