-- Migration 020: Cached AI Teams
-- Adds local cache for AI team configurations synced from control plane
-- Per Section 4: Tenant runtime caches control plane state for resilience

-- Cached AI teams table for local lookups
CREATE TABLE IF NOT EXISTS cached_ai_teams (
  ai_team_id           UUID          PRIMARY KEY,
  tenant_id            UUID          NOT NULL,
  role                 VARCHAR(255)  NOT NULL,
  status               VARCHAR(50)   NOT NULL DEFAULT 'draft',
  integrations         JSONB         DEFAULT '[]',
  entity_version       INTEGER       NOT NULL DEFAULT 1,
  synced_at            TIMESTAMP WITH TIME ZONE NOT NULL DEFAULT NOW(),

  CONSTRAINT cached_ai_teams_tenant_idx UNIQUE (ai_team_id, tenant_id)
);

-- Index for tenant lookups
CREATE INDEX idx_cached_ai_teams_tenant ON cached_ai_teams (tenant_id);

-- Index for status filtering
CREATE INDEX idx_cached_ai_teams_status ON cached_ai_teams (status);

-- Add ai_team_id column to workflow_tasks if not exists
-- This allows pausing tasks for a specific AI team
ALTER TABLE workflow_tasks ADD COLUMN IF NOT EXISTS ai_team_id UUID;
CREATE INDEX IF NOT EXISTS idx_workflow_tasks_ai_team ON workflow_tasks (ai_team_id);
