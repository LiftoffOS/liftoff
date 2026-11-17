-- Migration: 023_ai_team_agent_mapping.sql
-- Addresses BE-001: Use DEFERRABLE constraint to allow transactional insert order
-- Addresses BE-008: Add proper NOT NULL constraints and defaults

BEGIN;

-- Add runtime config columns to agents table FIRST (before mapping table)
-- This ensures agent records can be created with all required fields
ALTER TABLE agents ADD COLUMN IF NOT EXISTS agent_type VARCHAR(1) NOT NULL DEFAULT 'B';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS hitl_level INTEGER NOT NULL DEFAULT 3;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS model_config JSONB NOT NULL DEFAULT '{}';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS exec_config JSONB NOT NULL DEFAULT '{}';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS memory_scope JSONB NOT NULL DEFAULT '{}';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS trigger_config JSONB;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS entity_version INTEGER NOT NULL DEFAULT 1;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS system_prompt TEXT NOT NULL DEFAULT '';
ALTER TABLE agents ADD COLUMN IF NOT EXISTS user_instructions TEXT NOT NULL DEFAULT '';

-- Mapping table between AI teams (control plane) and agents (tenant runtime)
-- DEFERRABLE INITIALLY DEFERRED allows inserting mapping before agent within same transaction
CREATE TABLE IF NOT EXISTS ai_team_agent_mapping (
  ai_team_id       UUID          PRIMARY KEY,
  agent_id         UUID          NOT NULL,
  tenant_id        UUID          NOT NULL,
  created_at       TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),
  CONSTRAINT fk_ai_team_agent_mapping_agent
    FOREIGN KEY (agent_id) REFERENCES agents(id) ON DELETE CASCADE
    DEFERRABLE INITIALLY DEFERRED
);

CREATE INDEX idx_ai_team_agent_mapping_tenant ON ai_team_agent_mapping (tenant_id);
CREATE INDEX idx_ai_team_agent_mapping_agent ON ai_team_agent_mapping (agent_id);

COMMIT;
