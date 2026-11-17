-- Qualify tool_classification_cache identity by integration_type.
--
-- Migration 081 keyed the unique index on (tool_name, COALESCE(tenant_id,'__global__')),
-- which drops integration_type. Two connectors or MCP servers in one tenant that expose
-- the same tool name (e.g. a connector and a custom MCP both with `search`) therefore
-- overwrite each other's classification, even though the row records different
-- integration_type values. Re-key the unique index to include integration_type so
-- distinct sources keep distinct classifications.
--
-- COALESCE(integration_type, '') so a NULL integration_type collapses to a single slot
-- rather than being treated as all-distinct. Existing rows are unique on the old, less
-- qualified key (a subset of the new key's columns), so they are automatically unique
-- under the new key — the CREATE cannot fail on current data. Fix-forward: this replaces
-- 081's index; 081 is not edited.

DROP INDEX IF EXISTS tool_classification_cache_pkey;
CREATE UNIQUE INDEX IF NOT EXISTS tool_classification_cache_pkey
  ON tool_classification_cache (tool_name, COALESCE(integration_type, ''), COALESCE(tenant_id, '__global__'));
