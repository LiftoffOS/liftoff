-- Persistent record of file watchers for lifetime billing + cleanup on sandbox destroy.
CREATE TABLE IF NOT EXISTS sandbox_watchers (
  sandbox_id text NOT NULL,
  watcher_id text NOT NULL,
  tenant_id uuid NOT NULL,
  agent_id text NOT NULL,
  invocation_id text NOT NULL,
  paths text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  stopped_at timestamptz,
  PRIMARY KEY (sandbox_id, watcher_id)
);
CREATE INDEX IF NOT EXISTS idx_sandbox_watchers_tenant ON sandbox_watchers(tenant_id);

ALTER TABLE sandbox_watchers ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_sandbox_watchers ON sandbox_watchers;
CREATE POLICY tenant_isolation_sandbox_watchers ON sandbox_watchers
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
