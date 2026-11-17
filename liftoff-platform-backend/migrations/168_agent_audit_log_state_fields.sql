-- Audit Log Hardening: add before/after state to agent audit log entries
-- Enables /dashboard/activity to show what data looked like before agent changes
ALTER TABLE agent_audit_logs
  ADD COLUMN IF NOT EXISTS pre_action_snapshot  JSONB,
  ADD COLUMN IF NOT EXISTS post_action_snapshot JSONB,
  ADD COLUMN IF NOT EXISTS external_response    JSONB,
  ADD COLUMN IF NOT EXISTS snapshot_status      VARCHAR;
  -- snapshot_status values: 'captured' | 'skipped_read_op' | 'skipped_create' | 'unavailable_approved'
