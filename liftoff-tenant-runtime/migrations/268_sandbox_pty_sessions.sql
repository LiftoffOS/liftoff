-- Persistent record of PTY sessions opened by agents for lifetime billing + audit recovery.
CREATE TABLE IF NOT EXISTS sandbox_pty_sessions (
  sandbox_id text NOT NULL,
  session_id text NOT NULL,
  tenant_id uuid NOT NULL,
  agent_id text NOT NULL,
  invocation_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  last_activity timestamptz NOT NULL DEFAULT NOW(),
  status text NOT NULL DEFAULT 'active',
  exited_at timestamptz,
  exit_code int,
  PRIMARY KEY (sandbox_id, session_id)
);
CREATE INDEX IF NOT EXISTS idx_sandbox_pty_sessions_tenant ON sandbox_pty_sessions(tenant_id, status);

ALTER TABLE sandbox_pty_sessions ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_sandbox_pty_sessions ON sandbox_pty_sessions;
CREATE POLICY tenant_isolation_sandbox_pty_sessions ON sandbox_pty_sessions
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
