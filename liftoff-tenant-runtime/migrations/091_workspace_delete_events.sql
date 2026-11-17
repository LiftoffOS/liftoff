-- workspace_delete_events
-- Rate-limit trail for DELETE /workspace endpoint (10/min per tenant).

CREATE TABLE IF NOT EXISTS workspace_delete_events (
  tenant_id UUID NOT NULL,
  deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_workspace_delete_events_lookup
  ON workspace_delete_events (tenant_id, deleted_at DESC);

CREATE INDEX IF NOT EXISTS idx_workspace_delete_events_reaper
  ON workspace_delete_events (deleted_at);

COMMENT ON TABLE workspace_delete_events IS
  'DELETE /workspace rate-limit trail. Reaped after 25 hours.';
