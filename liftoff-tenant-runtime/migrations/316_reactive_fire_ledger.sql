-- Lightweight fire log for the reactive no-progress loop guard. Each row records that a
-- subscription fired for a subject (a PR/issue/run) at a given watched-state signature.
-- The guard COUNTS same-signature fires (a loop: same state fired repeatedly) and total
-- fires in 24h (a runaway backstop). Run-idempotency (event_processing_ledger) already
-- dedupes redelivered events, so this layer only counts — no lease/fence needed.
--
-- Tenant-scoped with FORCE row-level security (app.tenant_id GUC), like every other tenant
-- table. Pruned by the reactive-window-pruner cron.
CREATE TABLE reactive_fire_ledger (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  subscription_id UUID NOT NULL,
  subject_key TEXT NOT NULL,          -- `${connectorRef}:${entityType}:${recordKey}`
  state_sig TEXT NOT NULL,            -- hash of the watched entity state (progress vs no-progress)
  fired_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_rfl_subject ON reactive_fire_ledger (subscription_id, subject_key, fired_at DESC);

ALTER TABLE reactive_fire_ledger ENABLE ROW LEVEL SECURITY;
ALTER TABLE reactive_fire_ledger FORCE ROW LEVEL SECURITY;
CREATE POLICY rfl_tenant ON reactive_fire_ledger
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true)::uuid);
