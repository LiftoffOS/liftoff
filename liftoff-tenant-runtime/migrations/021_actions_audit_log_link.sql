-- Migration 021: Link Actions to Audit Logs
-- Adds audit_log_id to actions table for correction lookups
-- Per Correction Protocol: Must be able to retrieve pre-action state by audit log ID

-- Add audit_log_id column to actions table
ALTER TABLE actions ADD COLUMN IF NOT EXISTS audit_log_id UUID;

-- Index for lookups by audit_log_id (used by correction state resolver)
CREATE INDEX IF NOT EXISTS idx_actions_audit_log ON actions (audit_log_id) WHERE audit_log_id IS NOT NULL;

-- Compound index for tenant + audit_log lookups
CREATE INDEX IF NOT EXISTS idx_actions_tenant_audit_log ON actions (tenant_id, audit_log_id) WHERE audit_log_id IS NOT NULL;
