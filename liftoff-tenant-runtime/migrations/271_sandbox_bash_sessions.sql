-- Persistent record of bash sessions for cwd persistence + lifetime billing.
CREATE TABLE IF NOT EXISTS sandbox_bash_sessions (
  sandbox_id text NOT NULL,
  session_id text NOT NULL,
  tenant_id uuid NOT NULL,
  agent_id text NOT NULL,
  invocation_id text NOT NULL,
  cwd text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  last_activity timestamptz NOT NULL DEFAULT NOW(),
  closed_at timestamptz,
  PRIMARY KEY (sandbox_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_sandbox_bash_sessions_tenant ON sandbox_bash_sessions(tenant_id);

ALTER TABLE sandbox_bash_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_sandbox_bash_sessions ON sandbox_bash_sessions;
CREATE POLICY tenant_isolation_sandbox_bash_sessions ON sandbox_bash_sessions
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
