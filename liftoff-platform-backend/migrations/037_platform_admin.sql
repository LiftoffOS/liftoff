-- migrations/037_platform_admin.sql
-- Add is_platform_admin column to accounts table for admin router authorization
-- Per Phase 0.1: SE-001 (Critical), TE-001 (Critical)

-- Add is_platform_admin column to accounts table
ALTER TABLE accounts ADD COLUMN IF NOT EXISTS is_platform_admin BOOLEAN NOT NULL DEFAULT false;

-- Create index for efficient admin queries
CREATE INDEX IF NOT EXISTS idx_accounts_platform_admin ON accounts(id) WHERE is_platform_admin = true;

-- Admin action audit log for comprehensive audit logging
CREATE TABLE IF NOT EXISTS admin_action_audit (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  admin_id UUID NOT NULL REFERENCES accounts(id),
  action TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id TEXT,
  details JSONB,
  ip_address INET,
  user_agent TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_admin_action_audit_admin ON admin_action_audit(admin_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_action_audit_action ON admin_action_audit(action, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_admin_action_audit_target ON admin_action_audit(target_type, target_id, created_at DESC);
