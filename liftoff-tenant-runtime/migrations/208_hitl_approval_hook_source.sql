-- migrations/208_hitl_approval_hook_source.sql
--
-- Distinguish HITL approval requests that came from the platform's HITL gate
-- vs. tenant-routed escalations from customer hooks.

ALTER TABLE hitl_approval_requests
  ADD COLUMN IF NOT EXISTS hook_source TEXT NOT NULL DEFAULT 'platform_hitl'
    CHECK (hook_source IN ('platform_hitl', 'customer_hook', 'hook_failure'));

ALTER TABLE hitl_approval_requests
  ADD COLUMN IF NOT EXISTS hook_id UUID REFERENCES customer_hooks(id) ON DELETE SET NULL;

-- Same column on audit_logs for cross-referencing
ALTER TABLE audit_logs
  ADD COLUMN IF NOT EXISTS hook_source TEXT;
