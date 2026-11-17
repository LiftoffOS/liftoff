-- Persist the in-flight token rotation grace window so a process restart
-- during the 5-minute window doesn't leak the prior secret version.
--
-- rotateToken() schedules an in-memory disable after 5 minutes. If the
-- process dies (Cloud Run redeploy, OOM, etc.) the scheduled timer is
-- lost. The sweep called by the new tunnel-token-grace Cloud Scheduler
-- job reads these columns and disables any prior version whose grace
-- window has expired.

ALTER TABLE mcp_tunnel_deployments
  ADD COLUMN prev_token_secret_version TEXT,
  ADD COLUMN prev_token_expires_at TIMESTAMPTZ;

-- Partial index — only rows with an in-flight grace window participate
-- in the sweep, so the index stays tiny even at scale.
CREATE INDEX idx_mcp_tunnel_deployments_prev_token_expires
  ON mcp_tunnel_deployments(prev_token_expires_at)
  WHERE prev_token_secret_version IS NOT NULL;
