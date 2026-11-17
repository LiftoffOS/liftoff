-- 312_external_agent_tool_freshness.sql
--
-- last_discovery_at: when this agent's tool surface was last re-read from its
-- live MCP server.
--
-- raw_mcp_tools was captured once at discovery and never refreshed. The
-- scheduled health check only pinged ("just initialize, don't re-discover") and
-- rediscovery was a manual per-agent SSE endpoint, so a vendor that changed its
-- tool surface left the snapshot wrong indefinitely. A vendor that shrinks a
-- large REST-shaped surface to a couple of tools leaves agents offered dozens
-- that answer "Unknown tool" — and the pre-dispatch existence check validated
-- against that same stale snapshot, so the calls sailed through and died at the
-- far end.
--
-- This column is what the sweep reads to decide whether the (LLM-backed)
-- discovery pipeline needs to re-run, and what an operator reads to see whether
-- an agent's governance metadata is current. NULL = never refreshed since 312.
--
-- No backfill for credential_secret_name here: the correct project depends on
-- tenants.gcp_project_id vs the control-plane project id, which lives in the
-- process environment and is not addressable from plain SQL (every migration in
-- this repo is .sql, run by node-pg-migrate). It is resolved in application code
-- instead — see resolveCredentialSecretResourceName in external-agents/service.ts
-- — which applies the same branch and also covers rows written by an older
-- instance mid-rollout.

BEGIN;

ALTER TABLE external_agents
  ADD COLUMN IF NOT EXISTS last_discovery_at TIMESTAMPTZ;

COMMENT ON COLUMN external_agents.last_discovery_at IS
  'When this agent''s tool surface was last re-read from its live MCP server (scheduled sweep or manual rediscover). NULL = never refreshed since migration 312. raw_mcp_tools is governance metadata — classifications, capability_changes, prompt summary — NOT the dispatch source of truth: the tenant runtime enumerates tools live per invocation behind a short TTL and falls back to this snapshot only when that fetch fails.';

COMMENT ON COLUMN external_agents.credential_secret_name IS
  'Secret Manager name for this agent''s credentials. Written fully qualified (projects/{project}/secrets/{name}) since migration 312; older rows hold a bare name and are resolved at read time by resolveCredentialSecretResourceName. Qualification matters because storeCredentials writes to the TENANT project when tenants.gcp_project_id is set and to the CONTROL-PLANE project otherwise, so the tenant runtime cannot reconstruct the path — it previously guessed its own project, missed, and silently downgraded to an unauthenticated call. Mirrors custom_mcp_servers'' auth secret resource name.';

COMMIT;
