-- What a run's reads returned and what it was given, so the write that
-- follows can be judged against them — in a table, because the judge and the
-- recorder are separate requests to a service with up to ten instances, and a
-- Map in one of them is invisible to the other nine.
--
-- Append-only, one fact per row, a duplicate fact ignored: two instances
-- recording the same run at once cannot lose each other's rows. Rows outlive
-- their run by a day and are swept by the store itself. Values are the
-- identifiers a vendor returned and the text a run was handed — the same
-- material the runtime already holds in memory for the length of a run.

CREATE TABLE IF NOT EXISTS invocation_provenance (
  tenant_id      UUID        NOT NULL,
  invocation_id  TEXT        NOT NULL,
  -- 'id': an identifier under a declared entity type; 'untyped': a bare one;
  -- 'given': text the run was legitimately handed.
  kind           TEXT        NOT NULL CHECK (kind IN ('id', 'untyped', 'given')),
  -- Empty rather than NULL so the primary key can hold it: a NULL is never
  -- equal to another NULL, and the duplicate rule would stop working.
  entity_type    TEXT        NOT NULL DEFAULT '',
  value          TEXT        NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (invocation_id, kind, entity_type, value)
);

CREATE INDEX IF NOT EXISTS invocation_provenance_created_at_idx
  ON invocation_provenance (created_at);

-- This runtime serves every tenant in one database; a table carrying a
-- tenant_id and no policy is one forgotten WHERE clause from another
-- customer's rows. Same policy variable as the runtime's other tenant tables.
ALTER TABLE invocation_provenance ENABLE ROW LEVEL SECURITY;
ALTER TABLE invocation_provenance FORCE ROW LEVEL SECURITY;
CREATE POLICY invocation_provenance_tenant ON invocation_provenance
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMENT ON TABLE invocation_provenance IS
  'Per-run provenance: identifiers a run''s reads returned and text it was given, judged against by the write-provenance guard. Append-only; swept after a day.';
