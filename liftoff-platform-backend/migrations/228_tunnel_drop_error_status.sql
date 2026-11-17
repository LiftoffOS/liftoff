-- Tighten mcp_tunnel_deployments.status to the three values the code can
-- actually produce: 'pending', 'active', 'disconnected'.
--
-- 'error' was on the original enum but no code path ever wrote it — the
-- heartbeat endpoint only accepts 'active' | 'disconnected', the pending
-- sweep deletes rows rather than transitioning, and the disconnected
-- sweep flips active → disconnected. The frontend rendering of an error
-- state was unreachable. Dropping the value here keeps the schema and the
-- app in sync; if a genuine error signal is added later, a new migration
-- can re-introduce it alongside the heartbeat enum + UI.

ALTER TABLE mcp_tunnel_deployments
  DROP CONSTRAINT mcp_tunnel_deployments_status_check;

ALTER TABLE mcp_tunnel_deployments
  ADD CONSTRAINT mcp_tunnel_deployments_status_check
  CHECK (status IN ('pending', 'active', 'disconnected'));
