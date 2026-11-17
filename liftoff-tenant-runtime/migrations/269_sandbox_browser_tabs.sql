-- Persistent record of browser tabs for lifetime billing + forensic trace.
CREATE TABLE IF NOT EXISTS sandbox_browser_tabs (
  sandbox_id text NOT NULL,
  tab_id text NOT NULL,
  tenant_id uuid NOT NULL,
  agent_id text NOT NULL,
  invocation_id text NOT NULL,
  current_url text,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  last_activity timestamptz NOT NULL DEFAULT NOW(),
  closed_at timestamptz,
  PRIMARY KEY (sandbox_id, tab_id)
);
CREATE INDEX IF NOT EXISTS idx_sandbox_browser_tabs_tenant ON sandbox_browser_tabs(tenant_id);

ALTER TABLE sandbox_browser_tabs ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_sandbox_browser_tabs ON sandbox_browser_tabs;
CREATE POLICY tenant_isolation_sandbox_browser_tabs ON sandbox_browser_tabs
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
