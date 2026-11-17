-- Migration: 030_hitl_late_feedback
-- Description: Create table to store late feedback for agent learning when HITL approvals expire

-- UP Migration
CREATE TABLE hitl_late_feedback (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  approval_id           TEXT NOT NULL,
  agent_id              TEXT NOT NULL,
  ai_team_id            UUID REFERENCES ai_teams(id) ON DELETE SET NULL,
  workflow_id           TEXT,
  hitl_level            INTEGER NOT NULL CHECK (hitl_level IN (1, 2)),
  tool_calls_hash       TEXT NOT NULL,
  pending_tool_calls    JSONB NOT NULL CHECK (pg_column_size(pending_tool_calls) <= 1048576),
  gate_reason           TEXT NOT NULL,
  decision              TEXT NOT NULL CHECK (decision IN ('would_approve', 'would_reject')),
  decided_by            UUID NOT NULL,
  decided_by_role       TEXT NOT NULL,
  rejection_reason      TEXT CHECK (rejection_reason IS NULL OR length(rejection_reason) <= 2048),
  approval_created_at   TIMESTAMPTZ NOT NULL,
  approval_expired_at   TIMESTAMPTZ NOT NULL,
  feedback_provided_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  synced_to_runtime     BOOLEAN NOT NULL DEFAULT FALSE,
  sync_attempts         INTEGER NOT NULL DEFAULT 0,
  last_sync_error       TEXT,
  synced_at             TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_id, approval_id)
);

-- Indexes for efficient queries
CREATE INDEX idx_late_feedback_tenant ON hitl_late_feedback(tenant_id);
CREATE INDEX idx_late_feedback_agent ON hitl_late_feedback(agent_id);
CREATE INDEX idx_late_feedback_tool_hash ON hitl_late_feedback(tool_calls_hash);
CREATE INDEX idx_late_feedback_unsynced ON hitl_late_feedback(synced_to_runtime)
  WHERE NOT synced_to_runtime AND sync_attempts < 5;

-- DOWN Migration (rollback)
-- DROP TABLE IF EXISTS hitl_late_feedback;
