-- Audit Log Hardening: add post-action snapshot and snapshot status tracking
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS post_action_snapshot  JSONB,
  ADD COLUMN IF NOT EXISTS snapshot_status        VARCHAR;
  -- snapshot_status values: 'captured' | 'skipped_read_op' | 'skipped_create' | 'unavailable_approved' | 'snapshot_unavailable'
