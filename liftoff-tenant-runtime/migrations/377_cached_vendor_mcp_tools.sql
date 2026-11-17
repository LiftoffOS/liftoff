-- Last known-good tool list per vendor-hosted MCP server.
--
-- WHY. `buildToolsSchema` learns a vendor server's tool names by asking the
-- server: `enumerateVendorMcpTools` does a live `tools/list` against
-- api.githubcopilot.com (and the equivalent for Notion/Stripe/custom servers),
-- cached in-process for five minutes. That list is what workflow-graph
-- validation checks a step against, and what a trigger-bound step resolves
-- against.
--
-- So graph validation depends on a third party answering, on a service that
-- scales to zero. When the call fails the enumerator degrades to `[]` — right
-- for the model's catalog, wrong for validation, because "I could not ask" and
-- "the tools are not there" become the same answer. The run then dies telling
-- the operator the workflow names a tool that does not exist, or that "the
-- host's tool surface may have changed". GitHub's surface had not changed; the
-- request had failed. Observed as HTTP 500 (copilot user lookup) and HTTP 502
-- from GitHub's own edge.
--
-- A stored list turns that into a stale answer, which is very nearly always the
-- right one: a vendor's tool surface changes on the order of months, and a bad
-- minute lasts a minute.
--
-- NOT A CACHE FOR SPEED. The in-process map already does that. This exists only
-- to answer "what did this server say last time it answered", so it is written
-- on every successful fetch and read only on failure.
--
-- No FK to tenants(id). This is a cache, and a cache does not need referential
-- integrity — while a missing tenants row breaking a write is a failure mode
-- this estate has already paid for once.

CREATE TABLE IF NOT EXISTS cached_vendor_mcp_tools (
  tenant_id   uuid        NOT NULL,
  -- The connector instance alias the runtime namespaces tools with
  -- (`github-7d07a896`), NOT the connector type. Two accounts of the same
  -- vendor are two servers with two credentials and possibly two surfaces.
  server_id   text        NOT NULL,
  -- The RAW vendor entries, exactly as `tools/list` returned them
  -- (name/description/inputSchema/annotations). Stored pre-namespacing and
  -- pre-classification so the fallback path runs the same mapping the live
  -- path does, rather than a second copy of it that can drift.
  tools       jsonb       NOT NULL,
  fetched_at  timestamptz NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, server_id)
);

ALTER TABLE cached_vendor_mcp_tools ENABLE ROW LEVEL SECURITY;

CREATE POLICY cached_vendor_mcp_tools_tenant_isolation ON cached_vendor_mcp_tools
  USING (tenant_id = current_setting('app.tenant_id', true)::uuid);

COMMENT ON TABLE cached_vendor_mcp_tools IS
  'Last known-good tools/list per vendor MCP server. Read only when a live probe fails, so a vendor outage degrades graph validation to a stale answer instead of an empty one.';
COMMENT ON COLUMN cached_vendor_mcp_tools.server_id IS
  'Connector instance alias (github-7d07a896), not connector type.';
COMMENT ON COLUMN cached_vendor_mcp_tools.fetched_at IS
  'When the server last answered. Reported on the degraded path so an operator can see how stale the answer is.';
