-- Migration 008: Add trace_id and undo_support_mode to actions table
-- Per Section 11: Tool gateway enforces trace IDs and reversibility metadata

-- Add trace_id column for distributed tracing correlation
-- Per Section 11: Every action must include trace IDs
ALTER TABLE actions ADD COLUMN IF NOT EXISTS trace_id VARCHAR(64);

-- Add undo_support_mode column for reversibility metadata
-- Per Section 11: Track which actions support undo and how
-- Values: 'full', 'partial', 'none'
ALTER TABLE actions ADD COLUMN IF NOT EXISTS undo_support_mode VARCHAR(20);

-- Add instruction_version column for audit purposes
-- Per Section 11: Tool gateway enforces instruction version
ALTER TABLE actions ADD COLUMN IF NOT EXISTS instruction_version INTEGER;

-- Add conflict_resolution_mode used for this action
-- Per Section 11: Track which conflict resolution strategy was applied
ALTER TABLE actions ADD COLUMN IF NOT EXISTS conflict_resolution_mode VARCHAR(50);

-- Add payload column to store the action payload
-- Per Section 7: For every external write-capable action, persist action intent
ALTER TABLE actions ADD COLUMN IF NOT EXISTS payload JSONB;

-- Create index on trace_id for trace correlation queries
CREATE INDEX IF NOT EXISTS idx_actions_trace_id ON actions(trace_id);

-- Create index on tenant_id + created_at for audit queries
CREATE INDEX IF NOT EXISTS idx_actions_tenant_created ON actions(tenant_id, created_at DESC);

-- Create index on undo_support_mode for compensation planning
CREATE INDEX IF NOT EXISTS idx_actions_undo_mode ON actions(undo_support_mode) WHERE undo_support_mode IS NOT NULL;
