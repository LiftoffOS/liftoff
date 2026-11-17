-- Sandbox audit log: per-action audit entries for shell|file|browser|vscode
-- subsystems running inside a sandbox container. The earlier sandbox audit
-- migration did not land in this repo, so create the table from scratch with
-- the component column already present.
CREATE TABLE IF NOT EXISTS sandbox_audit_log (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  sandbox_id    text NOT NULL,
  tenant_id     uuid NOT NULL,
  agent_id      text,
  invocation_id text,
  component     text,
  action        text NOT NULL,
  details       jsonb,
  ts            timestamptz NOT NULL DEFAULT NOW()
);

-- Apply the column add as well so that re-runs against an environment where
-- the table already existed pre-migration still get the component column.
ALTER TABLE sandbox_audit_log
  ADD COLUMN IF NOT EXISTS component text;

CREATE INDEX IF NOT EXISTS idx_sandbox_audit_component ON sandbox_audit_log(component);
CREATE INDEX IF NOT EXISTS idx_sandbox_audit_tenant_ts ON sandbox_audit_log(tenant_id, ts DESC);

ALTER TABLE sandbox_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_sandbox_audit_log ON sandbox_audit_log;
CREATE POLICY tenant_isolation_sandbox_audit_log ON sandbox_audit_log
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);
