-- Partial indexes for the /api/teams/workforce latest-activity query
-- (workforce/service.ts getLatestActivityByAgent). That query runs
-- DISTINCT ON (entity_id) ... ORDER BY entity_id, created_at DESC over
-- internal_agent_id and external_agent_id separately. Without these indexes
-- the planner scans idx_agent_audit_tenant_created and sorts every audit row
-- the tenant has, on every teams-page load — fine at small volume, linear
-- degradation as audit volume grows.

CREATE INDEX IF NOT EXISTS idx_agent_audit_tenant_internal_created
  ON agent_audit_logs (tenant_id, internal_agent_id, created_at DESC)
  WHERE internal_agent_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_agent_audit_tenant_external_created
  ON agent_audit_logs (tenant_id, external_agent_id, created_at DESC)
  WHERE external_agent_id IS NOT NULL;
