-- Audit Log Hardening: add snapshot fields to audit_logs
-- These columns carry the pre/post action state snapshots through to
-- the platform-backend agent_audit_logs table so the dashboard can
-- display before/after state for connector writes.
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS pre_action_snapshot  JSONB;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS post_action_snapshot JSONB;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS external_response    JSONB;
ALTER TABLE audit_logs ADD COLUMN IF NOT EXISTS snapshot_status      VARCHAR;
  -- NULL                  — legacy rows (no snapshot data)
  -- 'captured'            — pre-action state successfully fetched
  -- 'skipped_read_op'     — action is read-only, no snapshot needed
  -- 'skipped_create'      — create action, post_action_snapshot used instead
  -- 'unavailable_approved'— human explicitly approved proceeding without snapshot
  -- 'unavailable'         — snapshot capture failed, write was blocked
