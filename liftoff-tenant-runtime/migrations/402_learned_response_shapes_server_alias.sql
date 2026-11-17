-- A learned response shape belongs to a SERVER, not only to a connector type.
--
-- `connector_type` alone cannot tell a tenant's two custom MCP servers apart,
-- nor a vendor-hosted GitHub server from the catalog's GitHub connector, so a
-- path accepted for one would have been read as accepted for the other. Rows
-- that came from the catalog keep '' here; rows from a vendor-hosted or custom
-- server carry the server alias the runtime dispatches on.
--
-- NOT NULL DEFAULT '' rather than nullable: two NULLs are never equal under a
-- unique constraint, so a nullable alias would have let catalog observations
-- stop deduplicating. The old four-column constraint is replaced by the
-- five-column one, and the writer's ON CONFLICT is retargeted in the same
-- change.
--
-- No backfill: writers must insert through a tenant-scoped connection, since an
-- unscoped pool has every insert refused by the RLS policy (logged as
-- `learned_shapes_persist_failed`); rows written before this column existed
-- take the '' default.

ALTER TABLE learned_response_shapes
  ADD COLUMN IF NOT EXISTS server_alias TEXT NOT NULL DEFAULT '';

-- The auto-generated name is truncated to 63 characters by Postgres; both
-- spellings are dropped so a database built either way ends up the same.
ALTER TABLE learned_response_shapes
  DROP CONSTRAINT IF EXISTS learned_response_shapes_tenant_id_connector_type_action_typ_key;
ALTER TABLE learned_response_shapes
  DROP CONSTRAINT IF EXISTS learned_response_shapes_tenant_id_connector_type_action_type_path_key;

ALTER TABLE learned_response_shapes
  ADD CONSTRAINT learned_response_shapes_identity_key
  UNIQUE (tenant_id, connector_type, action_type, path, server_alias);

COMMENT ON COLUMN learned_response_shapes.server_alias IS
  'The server the shape was observed on — <type>-<8hex> for a vendor-hosted or custom MCP server; empty for a catalog connector.';
