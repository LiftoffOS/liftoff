-- Migration 009: HITL rate-limit bookkeeping table
--
-- Mirrors tenant-runtime migration 100. Splits autonomous-operation
-- rate-limit events out of audit_logs and into a dedicated table.
-- Previously, src/hitl-enforcement/service.ts wrote
-- `hitl_level_5_operation` and `hitl_level_4_auto_elevated` rows into
-- audit_logs for rate-limit counting. Those rows polluted the user-facing
-- activity feed and caused "No activity" on the Teams page.
--
-- This table exists ONLY for getRecentOperationCount(). It is not
-- surfaced to users and carries no agent-level detail (agent_id is
-- unavailable in the governance engine's checkHitlGate() path).

CREATE TABLE hitl_rate_limit_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     TEXT NOT NULL,
  hitl_level    INTEGER NOT NULL CHECK (hitl_level IN (4, 5)),
  tool_name     TEXT NOT NULL,
  auto_elevated BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_hitl_rate_limit_tenant_created
  ON hitl_rate_limit_events (tenant_id, created_at DESC);

ALTER TABLE hitl_rate_limit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY hitl_rate_limit_events_tenant_isolation ON hitl_rate_limit_events
  USING (tenant_id = current_setting('app.current_tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true));
