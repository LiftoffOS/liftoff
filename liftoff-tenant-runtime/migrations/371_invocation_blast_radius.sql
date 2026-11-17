-- How much one run has changed, so far.
--
-- Blast radius accumulates: the failure worth catching is four hundred deletes
-- issued one at a time, where every individual call is unremarkable. Holding
-- that total in process memory works for exactly one dispatch path — the LLM
-- loop, inside one pod. It does not work for the other two:
--
--   * Agent-authored sandbox code reaches connectors through a separate HTTP
--     request from the sidecar, which may land on a different pod entirely.
--   * A run that pauses for approval and resumes may resume anywhere.
--
-- An in-memory total therefore reports a per-call number as a run total on
-- those paths — coverage that looks complete and under-counts by however much
-- already happened. This table is the shared counter, keyed by invocation, so
-- every path adds to the same number.
--
-- One row per invocation, upserted with an atomic increment. The write happens
-- once per DISPATCHED batch, alongside the audit insert that already runs
-- there, so it adds no round trip that was not already being paid.

CREATE TABLE invocation_blast_radius (
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  invocation_id UUID NOT NULL,
  -- Distinct entities the run has touched.
  entities_touched INTEGER NOT NULL DEFAULT 0,
  -- Deletes, archives, removals and deactivations, counted per entity.
  destructive_ops INTEGER NOT NULL DEFAULT 0,
  -- Fields set to empty where the pre-action snapshot had content. Clearing a
  -- field is how data disappears without a delete, and no name-based rule sees
  -- it.
  cleared_fields INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, invocation_id)
);

-- Rows are only interesting while their run is live; this index serves the
-- maintenance sweep that removes the rest.
CREATE INDEX idx_invocation_blast_radius_age
  ON invocation_blast_radius (updated_at);

-- RLS, fail-loud. `current_setting('app.tenant_id')` WITHOUT the `true` second
-- argument: a missing GUC raises rather than returning NULL. The silent variant
-- compares tenant_id to NULL, which is never true, so every read returns ZERO
-- ROWS and succeeds — and a zero blast radius is precisely the answer that lets
-- an unbounded run through the gate. Migration 079 documents the convention.
ALTER TABLE invocation_blast_radius ENABLE ROW LEVEL SECURITY;
ALTER TABLE invocation_blast_radius FORCE ROW LEVEL SECURITY;
CREATE POLICY invocation_blast_radius_tenant ON invocation_blast_radius
  USING (tenant_id = current_setting('app.tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.tenant_id')::uuid);
