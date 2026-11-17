-- Migration 100: HITL rate-limit bookkeeping table
--
-- Splits autonomous-operation rate-limit events out of audit_logs and into a
-- dedicated table. Previously, src/hitl-enforcement/service.ts wrote
-- `hitl_level_5_operation` and `hitl_level_4_auto_elevated` rows into
-- audit_logs purely so getRecentOperationCount() could count them for the
-- 1000-ops/hour limit. Those rows then dominated the user-facing /activity
-- feed, drowning out real tool actions.
--
-- This table exists ONLY for getRecentOperationCount(). It is not surfaced
-- to users and never mirrored to the platform-backend control plane.
--
-- RLS is enabled to match the fail-loud isolation pattern from migration 079.
-- All writes/reads must run inside withTenantScope().

CREATE TABLE hitl_rate_limit_events (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id     UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  agent_id      UUID,
  hitl_level    INTEGER NOT NULL CHECK (hitl_level IN (4, 5)),
  tool_name     TEXT NOT NULL,
  auto_elevated BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_hitl_rate_limit_tenant_created
  ON hitl_rate_limit_events(tenant_id, created_at DESC);

ALTER TABLE hitl_rate_limit_events ENABLE ROW LEVEL SECURITY;

CREATE POLICY hitl_rate_limit_events_tenant_isolation ON hitl_rate_limit_events
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
