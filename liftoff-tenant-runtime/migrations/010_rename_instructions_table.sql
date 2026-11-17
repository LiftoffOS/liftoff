-- Migration 010: Rename instructions table to compiled_instructions
-- MEDIUM GAP: Table name mismatch between migration and repository code
-- The repository references compiled_instructions but migration creates instructions

-- Rename the table to match repository expectations
ALTER TABLE IF EXISTS instructions RENAME TO compiled_instructions;

-- Rename indexes to be consistent
ALTER INDEX IF EXISTS idx_instructions_agent RENAME TO idx_compiled_instructions_agent;
ALTER INDEX IF EXISTS idx_instructions_status RENAME TO idx_compiled_instructions_status;

-- Add additional columns referenced by repository but missing from original migration
ALTER TABLE compiled_instructions ADD COLUMN IF NOT EXISTS instruction JSONB;
ALTER TABLE compiled_instructions ADD COLUMN IF NOT EXISTS validation_result JSONB;
ALTER TABLE compiled_instructions ADD COLUMN IF NOT EXISTS preview JSONB;
ALTER TABLE compiled_instructions ADD COLUMN IF NOT EXISTS activated_at TIMESTAMP WITH TIME ZONE;

-- Create index for active instructions lookup
CREATE INDEX IF NOT EXISTS idx_compiled_instructions_active
ON compiled_instructions(tenant_id, agent_id, status)
WHERE status = 'active';
