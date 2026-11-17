-- Migration 510: a capability's result is kept for an hour, so the rest of it
-- can be read without running the capability again.
--
-- A capability run hands the model a rendering of its result within a
-- budget (result-rendering.ts): whole records up to the budget, and a note
-- saying how many it left out. Without a way to read on, an assistant that
-- asks for twenty posts with their comments sees the first five, and runs the
-- same actor again and again to see more — paying for the whole feed each
-- time. The records it needs are already fetched and already paid for.
--
-- This table is where the whole result waits. A run whose rendering left
-- records out stores its structured result here, keyed by an id the model is
-- handed with the next offset; run_capability with that id and offset renders
-- the next page from this row, dispatches nothing and charges nothing. Rows
-- expire after an hour (a result is read on within the turn that produced it,
-- or not at all) and are swept as new ones are written.
--
-- Tenant data (a workspace's vendor results), so RLS as 495: every read and
-- write carries the tenant.

CREATE TABLE IF NOT EXISTS capability_results (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  source       TEXT NOT NULL,
  source_ref   TEXT NOT NULL,
  content      JSONB NOT NULL,
  record_count INTEGER NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '1 hour'
);

CREATE INDEX IF NOT EXISTS idx_capability_results_tenant_expiry
  ON capability_results (tenant_id, expires_at);

ALTER TABLE capability_results ENABLE ROW LEVEL SECURITY;
ALTER TABLE capability_results FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON capability_results
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMENT ON TABLE capability_results IS
  'A capability run''s whole structured result, kept for an hour so run_capability can render its later pages by offset without dispatching the capability again. source/source_ref name the building block that produced it, as capability_usage_evidence does.';
