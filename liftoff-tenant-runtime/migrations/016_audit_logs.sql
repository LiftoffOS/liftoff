-- Audit Logs (Immutable Activity Trail)
-- Audit Logs

-- ---------------------------------------------------------------------------
-- AUDIT_LOGS
-- Append-only immutable audit trail of every agent action.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS audit_logs (
  id                   UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,

  -- Who performed the action
  ai_team_id           UUID        REFERENCES agents(id),
  user_id              UUID,       -- Human user if applicable

  -- Context
  thread_id            UUID        REFERENCES threads(id),
  invocation_id        UUID        REFERENCES invocations(id),

  -- What happened
  action               TEXT        NOT NULL,  -- e.g. 'gmail_send_email', 'memory.save'
  input_args           JSONB       NOT NULL DEFAULT '{}',  -- Sanitized (no credentials/PII)
  output_summary       TEXT,       -- Brief result description
  outcome              TEXT        NOT NULL CHECK (outcome IN ('success', 'error', 'gated')),
  error_code           TEXT,       -- If outcome = 'error'

  -- Who triggered it
  triggered_by         TEXT        NOT NULL,  -- 'human:<user_id>', 'agent', 'cron', 'event:<topic>'

  -- Timing
  duration_ms          INTEGER,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

COMMENT ON TABLE audit_logs IS
  'Immutable append-only audit trail. Every agent function call is logged here. DELETE and UPDATE are blocked by rule.';

-- Immutability enforced by rules - no deletes, no updates
CREATE RULE audit_logs_no_delete AS ON DELETE TO audit_logs DO INSTEAD NOTHING;
CREATE RULE audit_logs_no_update AS ON UPDATE TO audit_logs DO INSTEAD NOTHING;

-- Indexes for common queries
CREATE INDEX idx_audit_logs_tenant_created   ON audit_logs (tenant_id, created_at DESC);
CREATE INDEX idx_audit_logs_ai_team          ON audit_logs (ai_team_id);
CREATE INDEX idx_audit_logs_thread           ON audit_logs (thread_id);
CREATE INDEX idx_audit_logs_invocation       ON audit_logs (invocation_id);
CREATE INDEX idx_audit_logs_action           ON audit_logs (tenant_id, action);
CREATE INDEX idx_audit_logs_outcome          ON audit_logs (tenant_id, outcome) WHERE outcome != 'success';

-- RLS
ALTER TABLE audit_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY audit_logs_tenant_isolation ON audit_logs
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMENT ON COLUMN audit_logs.action IS 'Tool/function name that was called';
COMMENT ON COLUMN audit_logs.input_args IS 'Sanitized arguments (credentials redacted, large values truncated)';
COMMENT ON COLUMN audit_logs.outcome IS 'success=completed, error=failed, gated=blocked by HITL';
COMMENT ON COLUMN audit_logs.triggered_by IS 'Source: human:<user_id>, agent, cron, event:<topic>';
