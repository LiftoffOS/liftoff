-- 268_custom_mcp_servers_connector_pk.sql
--
-- Promote custom_mcp_servers.connector_id to PRIMARY KEY and drop the
-- redundant local `id` UUID PK.
--
-- Why: every connection on the /connections page (Gmail, Slack,
-- custom_mcp_server, tunneled MCP) lives as ONE row in `connectors`.
-- `connectors.id` is the canonical, system-wide identifier — what agent
-- bindings store in `integration.id`, what /connections URLs use, what
-- secret names embed. Sibling table `connector_credentials` got this right
-- (`connector_id UUID PRIMARY KEY REFERENCES connectors(id)`); migration
-- 225 created `custom_mcp_servers` with a redundant `id UUID PRIMARY KEY`
-- in addition to the `connector_id` FK. That redundant PK leaked into
-- `/api/internal/custom-mcp-servers/by-id` whose `WHERE id = $1` then
-- diverged from every other lookup keyed off `connectors.id` — tenant-
-- runtime passed the agent-binding id (= connectors.id), PB hit a 404,
-- the MCP server's tool catalog never registered, and any agent bound
-- to a custom_mcp_server silently lost its tool surface.
--
-- Promoting connector_id to PK makes the bug structurally impossible:
-- there is only one identifier left, and it is the same identifier the
-- rest of the system already uses.
--
-- Safety:
--   * No FK targets `custom_mcp_servers.id` (verified by grep across
--     all migrations). Nothing to re-point.
--   * UNIQUE(connector_id) is already implied 1:1 in code — every row
--     was created with a fresh connector_id via createConnectorForTenant.
--     Verified before the PK promotion with a duplicate-check; if any
--     duplicates exist the migration aborts with a clear message.
--   * The existing `auth_secret_name` column already stores each row's
--     historical secret name, so dropping `id` does not orphan any
--     Secret Manager entries — tenant-runtime now reads `authSecretName`
--     from the by-id response (no more reconstruction from `id`).

BEGIN;

-- Defensive duplicate check (must hold 1:1 before PK promotion).
DO $$
DECLARE
  dup_count int;
BEGIN
  SELECT COUNT(*) INTO dup_count FROM (
    SELECT connector_id FROM custom_mcp_servers
    GROUP BY connector_id HAVING COUNT(*) > 1
  ) d;
  IF dup_count > 0 THEN
    RAISE EXCEPTION 'Cannot promote connector_id to PK: % connector_id values have >1 custom_mcp_servers row. Resolve duplicates before re-running.', dup_count;
  END IF;
END $$;

ALTER TABLE custom_mcp_servers DROP CONSTRAINT custom_mcp_servers_pkey;
ALTER TABLE custom_mcp_servers ADD PRIMARY KEY (connector_id);
ALTER TABLE custom_mcp_servers DROP COLUMN id;

-- idx_custom_mcp_servers_connector becomes redundant (PK already indexes
-- connector_id). Drop it; PK index serves all the same query patterns.
DROP INDEX IF EXISTS idx_custom_mcp_servers_connector;

COMMIT;
