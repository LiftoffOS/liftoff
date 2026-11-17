-- Warehouse connection health — reachability probe (implementation plan §4).
--
-- No data-warehouse vendor pushes a credential-revocation event, so connection
-- health is PROBE-derived. Two mechanisms use these columns + function:
--   • a verify-probe at connect time (client SELECT 1 / datasets.list),
--   • a scheduled reachability-probe worker (warehouse analog of the OAuth
--     token-keepalive, which only covers rotating-OAuth connectors today).
-- A probe that fails with an auth/permission error flips connectors.status
-- ='error' — the signal the connections UI already renders as "Needs Reconnect".
--
-- SCOPE: the NATIVE warehouse connectors only (snowflake, databricks,
-- google_bigquery). supabase is composio_managed — Composio owns its health,
-- exactly as token-keepalive excludes composio_managed.

BEGIN;

ALTER TABLE connectors
  ADD COLUMN IF NOT EXISTS last_reachability_probe_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS last_reachability_error    TEXT;

-- Cross-tenant enumeration of active native-warehouse connectors due for a
-- probe. SECURITY DEFINER (runs before tenant context is set); each per-row
-- probe re-enters tenant scope via the credential service + withTenantScope.
CREATE OR REPLACE FUNCTION list_probeable_warehouse_connectors(probe_interval interval)
RETURNS TABLE(tenant_id text, connector_id uuid, connector_type text)
LANGUAGE sql
SECURITY DEFINER
SET search_path = public
AS $$
  SELECT c.tenant_id, c.id, c.type
  FROM connectors c
  WHERE c.status = 'active'
    AND c.type IN ('snowflake', 'databricks', 'google_bigquery')
    AND (
      c.last_reachability_probe_at IS NULL
      OR c.last_reachability_probe_at < now() - probe_interval
    );
$$;

COMMIT;
