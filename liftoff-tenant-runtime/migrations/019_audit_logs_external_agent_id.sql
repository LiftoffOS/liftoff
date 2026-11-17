-- Add external_agent_id to audit_logs for tracking A2A collaboration activity
-- External agents are managed in Platform Backend, so no FK constraint here

ALTER TABLE audit_logs
ADD COLUMN external_agent_id UUID;

-- Index for querying activity by external agent
CREATE INDEX idx_audit_logs_external_agent
ON audit_logs(external_agent_id)
WHERE external_agent_id IS NOT NULL;

-- Composite index for external agent activity queries with time filtering
CREATE INDEX idx_audit_logs_external_agent_created
ON audit_logs(external_agent_id, created_at DESC)
WHERE external_agent_id IS NOT NULL;

COMMENT ON COLUMN audit_logs.external_agent_id IS
  'External agent involved in this action (references Platform Backend external_agents.id)';
