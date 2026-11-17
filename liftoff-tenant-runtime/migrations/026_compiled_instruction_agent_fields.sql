-- Migration 026: Add internal agent fields to compiled_instructions table
-- Simplified Instruction Service needs these fields for AI team activation

BEGIN;

-- Add fields needed for internal agent instruction creation
ALTER TABLE compiled_instructions ADD COLUMN IF NOT EXISTS system_prompt TEXT NOT NULL DEFAULT '';
ALTER TABLE compiled_instructions ADD COLUMN IF NOT EXISTS user_instructions TEXT NOT NULL DEFAULT '';
ALTER TABLE compiled_instructions ADD COLUMN IF NOT EXISTS hitl_level INTEGER NOT NULL DEFAULT 3;
ALTER TABLE compiled_instructions ADD COLUMN IF NOT EXISTS integrations JSONB NOT NULL DEFAULT '[]';
ALTER TABLE compiled_instructions ADD COLUMN IF NOT EXISTS trigger_config JSONB;
ALTER TABLE compiled_instructions ADD COLUMN IF NOT EXISTS source VARCHAR(50) NOT NULL DEFAULT 'manual';
ALTER TABLE compiled_instructions ADD COLUMN IF NOT EXISTS failure_reason TEXT;

-- Index for looking up active instructions by agent and status
CREATE INDEX IF NOT EXISTS idx_compiled_instructions_agent_active
ON compiled_instructions(agent_id, status) WHERE status = 'active';

COMMIT;
