-- Add external_agent_id to agent_audit_logs for tracking A2A collaboration activity
-- This enables querying activity by external agent for cards/dashboards

ALTER TABLE agent_audit_logs
ADD COLUMN external_agent_id UUID REFERENCES external_agents(id) ON DELETE SET NULL;

-- Index for querying activity by external agent
CREATE INDEX idx_agent_audit_external_agent
ON agent_audit_logs(external_agent_id)
WHERE external_agent_id IS NOT NULL;

-- Composite index for external agent activity queries with time filtering
CREATE INDEX idx_agent_audit_external_agent_created
ON agent_audit_logs(external_agent_id, created_at DESC)
WHERE external_agent_id IS NOT NULL;

COMMENT ON COLUMN agent_audit_logs.external_agent_id IS
  'External agent involved in this action (for A2A collaboration tracking)';
