-- Migration: Rename ai_team to internal_agent
-- Part of terminology standardization: "AI Team" (UI) → "Internal Agent" (code)
-- Strategy: ALTER TABLE RENAME (in-place, atomic)

BEGIN;

-- ============================================================================
-- 1. MAIN TABLE RENAMES
-- ============================================================================

ALTER TABLE ai_teams RENAME TO internal_agents;
ALTER TABLE ai_team_audit RENAME TO internal_agent_audit;
ALTER TABLE ai_team_idempotency_keys RENAME TO internal_agent_idempotency_keys;
ALTER TABLE ai_team_versions RENAME TO internal_agent_versions;
ALTER TABLE ai_team_oversight_settings RENAME TO internal_agent_oversight_settings;
ALTER TABLE ai_team_oversight_settings_versions RENAME TO internal_agent_oversight_settings_versions;

-- ============================================================================
-- 2. COLUMN RENAMES
-- ============================================================================

-- In renamed tables
ALTER TABLE internal_agent_audit RENAME COLUMN ai_team_id TO internal_agent_id;
ALTER TABLE internal_agent_idempotency_keys RENAME COLUMN ai_team_id TO internal_agent_id;
ALTER TABLE internal_agent_versions RENAME COLUMN ai_team_id TO internal_agent_id;

-- In other tables that reference ai_team_id
ALTER TABLE agent_audit_logs RENAME COLUMN ai_team_id TO internal_agent_id;
ALTER TABLE hitl_late_feedback RENAME COLUMN ai_team_id TO internal_agent_id;

-- In tenants and accounts tables
ALTER TABLE tenants RENAME COLUMN has_created_ai_team TO has_created_internal_agent;
ALTER TABLE accounts RENAME COLUMN recently_viewed_teams TO recently_viewed_internal_agents;

-- In external_agents table (allowed_team_ids → allowed_internal_agent_ids)
ALTER TABLE external_agents RENAME COLUMN allowed_team_ids TO allowed_internal_agent_ids;

-- ============================================================================
-- 3. INDEX RENAMES (from migration 016_ai_teams.sql)
-- ============================================================================

ALTER INDEX idx_ai_teams_tenant_id RENAME TO idx_internal_agents_tenant_id;
ALTER INDEX idx_ai_teams_tenant_status RENAME TO idx_internal_agents_tenant_status;
ALTER INDEX idx_ai_teams_tenant_created RENAME TO idx_internal_agents_tenant_created;
ALTER INDEX idx_ai_teams_last_active RENAME TO idx_internal_agents_last_active;
ALTER INDEX idx_ai_team_audit_team RENAME TO idx_internal_agent_audit_agent;
ALTER INDEX idx_ai_team_idempotency_expires RENAME TO idx_internal_agent_idempotency_expires;

-- ============================================================================
-- 4. INDEX RENAMES (from migration 023_ai_team_versions.sql)
-- ============================================================================

ALTER INDEX idx_ai_team_versions_team RENAME TO idx_internal_agent_versions_agent;
ALTER INDEX idx_ai_team_versions_team_latest RENAME TO idx_internal_agent_versions_agent_latest;

-- ============================================================================
-- 5. INDEX RENAMES (from migration 029_agent_audit_logs.sql)
-- ============================================================================

ALTER INDEX idx_agent_audit_ai_team RENAME TO idx_agent_audit_internal_agent;

-- ============================================================================
-- 6. INDEX RENAMES (from migration 033_performance_indexes.sql)
-- ============================================================================

-- idx_oversight_settings_tenant_version - no rename needed (doesn't contain ai_team)
ALTER INDEX idx_audit_logs_tenant_team_created RENAME TO idx_audit_logs_tenant_agent_created;

-- ============================================================================
-- 7. FUNCTION RENAME
-- ============================================================================

ALTER FUNCTION cleanup_expired_ai_team_idempotency_keys()
  RENAME TO cleanup_expired_internal_agent_idempotency_keys;

-- ============================================================================
-- 8. TRIGGER RENAME
-- ============================================================================

ALTER TRIGGER update_ai_team_oversight_settings_updated_at
  ON internal_agent_oversight_settings
  RENAME TO update_internal_agent_oversight_settings_updated_at;

-- ============================================================================
-- 9. UPDATE COMMENTS
-- ============================================================================

COMMENT ON TABLE internal_agents IS 'Internal AI agent configurations (UI: "AI Teams"). Controls agent behavior, integrations, and capabilities.';
COMMENT ON TABLE internal_agent_versions IS 'Versioned snapshots of internal agent configuration. Every change to role, responsibilities, integrations, additionalContext, systemPrompt, or userInstructions creates a new version.';
COMMENT ON TABLE internal_agent_audit IS 'Audit trail for internal agent lifecycle events (created, updated, deleted, status_changed).';
COMMENT ON TABLE internal_agent_idempotency_keys IS 'Idempotency keys for internal agent create operations to prevent duplicates.';
COMMENT ON TABLE internal_agent_oversight_settings IS 'Tenant-level oversight configuration for HITL enforcement. Determines autonomy levels and sensitive work categories.';
COMMENT ON TABLE internal_agent_oversight_settings_versions IS 'Version history for oversight settings changes (audit trail).';

COMMIT;
