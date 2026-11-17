-- Audit Log Hardening: add post-creation snapshot and snapshot status tracking
ALTER TABLE actions ADD COLUMN IF NOT EXISTS post_action_snapshot JSONB;
ALTER TABLE actions ADD COLUMN IF NOT EXISTS snapshot_status VARCHAR NOT NULL DEFAULT 'captured';
  -- 'captured'              — pre-action state successfully fetched
  -- 'skipped_read_op'       — action is read-only, no snapshot needed
  -- 'skipped_create'        — create action, post_action_snapshot used instead
  -- 'unavailable_approved'  — human explicitly approved proceeding without snapshot
