-- migrations/033_performance_indexes.sql
-- Note: Using regular CREATE INDEX (not CONCURRENTLY) because migrations run in transactions

-- AI Teams indexes for common queries
CREATE INDEX IF NOT EXISTS idx_ai_teams_tenant_status
  ON ai_teams(tenant_id, status);

CREATE INDEX IF NOT EXISTS idx_ai_teams_tenant_created
  ON ai_teams(tenant_id, created_at DESC);

-- Note: idx_ai_teams_last_active already exists from migration 016, skipping

-- Oversight settings indexes
CREATE INDEX IF NOT EXISTS idx_oversight_settings_tenant_version
  ON ai_team_oversight_settings(tenant_id, current_version DESC);

-- Agent audit logs - optimize common query patterns
CREATE INDEX IF NOT EXISTS idx_audit_logs_tenant_team_created
  ON agent_audit_logs(tenant_id, ai_team_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audit_logs_outcome
  ON agent_audit_logs(tenant_id, outcome, created_at DESC)
  WHERE outcome IN ('error', 'gated');

-- Tenant members indexes
CREATE INDEX IF NOT EXISTS idx_tenant_members_account
  ON tenant_members(account_id, tenant_id);

-- HITL late feedback indexes (if not already present)
CREATE INDEX IF NOT EXISTS idx_late_feedback_pending_sync
  ON hitl_late_feedback(synced_to_runtime, sync_attempts)
  WHERE NOT synced_to_runtime AND sync_attempts < 5;
