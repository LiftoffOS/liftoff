-- Agent Audit Logs: Immutable audit trail for agent tool executions
-- Addresses: BE-001, SE-007, BE-007, SE-006

CREATE TABLE agent_audit_logs (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- [BE-001] FK constraint for referential integrity
  tenant_id       UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  ai_team_id      UUID REFERENCES ai_teams(id) ON DELETE SET NULL,
  user_id         UUID,
  thread_id       UUID,
  invocation_id   UUID,
  action          TEXT NOT NULL,  -- e.g. 'gmail_send_email'

  -- [SE-005] Size-limited JSONB with CHECK constraint
  input_args      JSONB NOT NULL DEFAULT '{}'
                  CHECK (length(input_args::text) <= 65536),

  output_summary  TEXT CHECK (length(output_summary) <= 4096),
  outcome         TEXT NOT NULL CHECK (outcome IN ('success','error','gated')),
  error_code      TEXT,

  -- [SE-007] Constrained triggered_by format to prevent injection
  triggered_by    TEXT NOT NULL
                  CHECK (triggered_by ~ '^(human:[a-f0-9-]+|agent|cron|event:[a-zA-Z0-9_-]+)$'),

  duration_ms     INTEGER CHECK (duration_ms >= 0),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Immutability trigger (reuse existing function)
CREATE TRIGGER agent_audit_logs_immutable
  BEFORE UPDATE OR DELETE ON agent_audit_logs
  FOR EACH ROW EXECUTE FUNCTION prevent_audit_modification();

-- Indexes for common query patterns
CREATE INDEX idx_agent_audit_tenant_created ON agent_audit_logs(tenant_id, created_at DESC);
CREATE INDEX idx_agent_audit_ai_team ON agent_audit_logs(ai_team_id) WHERE ai_team_id IS NOT NULL;
CREATE INDEX idx_agent_audit_thread ON agent_audit_logs(thread_id) WHERE thread_id IS NOT NULL;
CREATE INDEX idx_agent_audit_invocation ON agent_audit_logs(invocation_id) WHERE invocation_id IS NOT NULL;
CREATE INDEX idx_agent_audit_action ON agent_audit_logs(action);
CREATE INDEX idx_agent_audit_outcome ON agent_audit_logs(outcome);

-- [BE-007] Index for triggered_by compliance queries
CREATE INDEX idx_agent_audit_triggered_by ON agent_audit_logs(triggered_by);
CREATE INDEX idx_agent_audit_human_triggered ON agent_audit_logs(triggered_by)
  WHERE triggered_by LIKE 'human:%';

-- [SE-006] Retention cleanup function (365 day default)
CREATE OR REPLACE FUNCTION cleanup_old_agent_audit_logs(retention_days INTEGER DEFAULT 365)
RETURNS INTEGER AS $$
DECLARE
  deleted_count INTEGER;
BEGIN
  DELETE FROM agent_audit_logs
  WHERE created_at < NOW() - (retention_days || ' days')::INTERVAL;
  GET DIAGNOSTICS deleted_count = ROW_COUNT;
  RETURN deleted_count;
END;
$$ LANGUAGE plpgsql;

COMMENT ON TABLE agent_audit_logs IS
  'Immutable audit trail for AI agent tool executions. Retention: 365 days default.';
