-- Connector OAuth token keepalive.
--
-- Direct-OAuth connectors (static_oauth / DCR) refresh their rotating tokens
-- ON-DEMAND — usually kept warm by polling. But a connection that goes idle
-- (suspended tenant, write-only/unpolled connector) past its refresh-token TTL
-- loses the token and forces a reconnect. This adds a proactive keepalive that
-- rotates dormant tokens on a schedule, independent of polling/activity, plus a
-- needs_reconnect flag for genuinely-dead tokens so the UI prompts exactly once.
--
-- SCOPE: excludes `slack` (special shared config-refresh chain — never touched
-- here), composio_managed (Composio owns the OAuth), and api_key / no-expiry
-- flows (nothing to refresh).

BEGIN;

ALTER TABLE connector_credentials
  ADD COLUMN IF NOT EXISTS needs_reconnect         BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS last_refresh_error      TEXT,
  ADD COLUMN IF NOT EXISTS last_refresh_attempt_at TIMESTAMPTZ;

-- Cross-tenant enumeration of DORMANT direct-OAuth credentials to rotate. Only
-- OAuth flows with an expiry, active connectors, not slack, not already dead,
-- and not refreshed in the last 12h (active/polled ones are already warm →
-- skipped). SECURITY DEFINER (runs pre-tenant-context); per-row refresh re-enters
-- tenant scope via the credential service.
CREATE OR REPLACE FUNCTION list_refreshable_credentials()
RETURNS TABLE(tenant_id text, connector_id uuid, connector_type text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT cc.tenant_id, cc.connector_id, c.type
  FROM connector_credentials cc
  JOIN connectors c ON c.id = cc.connector_id
  WHERE cc.flow_kind IN ('static_oauth', 'dynamic_client_registration')
    AND cc.expires_at_epoch_sec IS NOT NULL
    AND cc.needs_reconnect = FALSE
    AND c.status = 'active'
    AND c.type <> 'slack'
    AND cc.updated_at < now() - interval '12 hours';
$$;

COMMIT;
