-- Migration 511: fetched data is parked as a dataset, never carried in a
-- model's context.
--
-- A fetched result can be any size: a subreddit's posts with their comments,
-- a thousand company records, a month of orders. Migration 510 kept such a
-- result whole so that it could be read on by offset — and the model then
-- read it page after page into its own context until the turn ran out of
-- room, with the reply never written. Reading every record is the wrong
-- operation on a large result, whatever the page size.
--
-- A dataset is where a result lives instead: one row for the result and one
-- row per record, scoped to the job (the conversation or the run) that
-- fetched it, so the job can add to it as the work goes on. The model gets a
-- view — the count, the fields, two sample records, the id — and asks for
-- what it needs: a query (fields, filters, sort, limit) served from these
-- rows, or an instruction answered over the records by a model inside the
-- platform, so that no record has to pass through the context that is doing
-- the work. Rows last a day (a job, not a turn) and are swept as new ones
-- are written.
--
-- Tenant data (a workspace's fetched records), so RLS as 495 and 510: every
-- read and write carries the tenant. Records carry the tenant too, so the
-- policy needs no join.

CREATE TABLE IF NOT EXISTS datasets (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  scope_kind   TEXT NOT NULL,
  scope_id     TEXT NOT NULL,
  label        TEXT NOT NULL,
  source       TEXT NOT NULL,
  source_ref   TEXT NOT NULL,
  record_count INTEGER NOT NULL DEFAULT 0,
  bytes        BIGINT NOT NULL DEFAULT 0,
  fields       JSONB NOT NULL DEFAULT '[]'::jsonb,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at   TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '24 hours'
);

CREATE INDEX IF NOT EXISTS idx_datasets_tenant_scope
  ON datasets (tenant_id, scope_kind, scope_id, created_at);
CREATE INDEX IF NOT EXISTS idx_datasets_tenant_expiry
  ON datasets (tenant_id, expires_at);

ALTER TABLE datasets ENABLE ROW LEVEL SECURITY;
ALTER TABLE datasets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON datasets
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMENT ON TABLE datasets IS
  'A fetched result parked for the job (conversation or run) that fetched it: its records are dataset_records rows, queried and digested there so no record has to pass through a model''s context. source/source_ref name the building block that produced it, as capability_usage_evidence does; fields is the per-field shape the model is shown.';

CREATE TABLE IF NOT EXISTS dataset_records (
  dataset_id UUID NOT NULL REFERENCES datasets(id) ON DELETE CASCADE,
  tenant_id  UUID NOT NULL,
  ordinal    INTEGER NOT NULL,
  record     JSONB NOT NULL,
  PRIMARY KEY (dataset_id, ordinal)
);

CREATE INDEX IF NOT EXISTS idx_dataset_records_tenant
  ON dataset_records (tenant_id, dataset_id);

ALTER TABLE dataset_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE dataset_records FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON dataset_records
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMENT ON TABLE dataset_records IS
  'One fetched record of a dataset, in fetch order (ordinal, 1-based). A record appended by a later run of the same job carries a _run field with that run''s ordinal.';

-- The hour-long whole-result cache of migration 510 is replaced by the
-- dataset above; nothing reads it after this migration's release.
DROP TABLE IF EXISTS capability_results;
