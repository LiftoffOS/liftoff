-- A learned shape is one of two kinds: a path a read RETURNS an id at, or an
-- argument a write NAMES a record by.
--
-- The write gate needs both facts per tool, and until now this table held
-- only the first. The second was derived from a tool's input schema at the
-- boundary the tool entered by — which is the right source, and the wrong
-- authority: a derived `idArgs` is a guess about which argument names a
-- record, and the gate is forbidden to refuse on a guess. So every tool on a
-- vendor-hosted or custom MCP server was judged, reported, and never held,
-- and there was no home for a person to say the guess was right: nobody at
-- Liftoff can author declarations for a server only one workspace can see.
--
-- This is that home. The review queue already turns an observed path into an
-- accepted declaration; the same queue now carries the derived argument names
-- as proposals of a second kind. `path` holds the argument NAME for an
-- `id_arg` row — a name, never a value, so the table's contract is unchanged.
--
-- In the identity key, because one tool can have both a `number` argument and
-- a `number` response path, and the two are different facts with different
-- decisions.
--
-- No backfill: every existing row is a response path.

ALTER TABLE learned_response_shapes
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'returns_id'
    CHECK (kind IN ('returns_id', 'id_arg'));

ALTER TABLE learned_response_shapes
  DROP CONSTRAINT IF EXISTS learned_response_shapes_identity_key;

ALTER TABLE learned_response_shapes
  ADD CONSTRAINT learned_response_shapes_identity_key
  UNIQUE (tenant_id, connector_type, action_type, path, server_alias, kind);

COMMENT ON COLUMN learned_response_shapes.kind IS
  'returns_id: `path` is a response path an id was observed at. id_arg: `path` is the name of a write argument that names a record.';
