-- Remove the vestigial connector_credentials.needs_reconnect column.
--
-- Migration 020 added it, but the "Needs Reconnect" signal the connections UI
-- reads is the connector's own status ('error'), which the keepalive now flips
-- via the standard markConnectorReconnectRequired path. The column was never
-- read → drop it and rebuild the refreshable-credentials enumeration to exclude
-- dead connectors via status (they're already status='error') instead. The
-- last_refresh_error / last_refresh_attempt_at diagnostics stay.

BEGIN;

DROP FUNCTION IF EXISTS list_refreshable_credentials();

ALTER TABLE connector_credentials DROP COLUMN IF EXISTS needs_reconnect;

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
    AND c.status = 'active'          -- dead connectors are status='error' → excluded
    AND c.type <> 'slack'
    AND cc.updated_at < now() - interval '12 hours';
$$;

COMMIT;
