-- Composio cutover-completion (C5): persist the Composio connected-account
-- id alongside each per-tenant connector manifest. The dispatcher
-- (src/tool-gateway/composio-dispatcher.ts) passes this as
-- composio.tools.execute({ connectedAccountId }) so multi-account tenants
-- (allowMultiple: true at install, per composio-client.ts:68) get
-- disambiguated to the right Composio connection.
--
-- Source of truth: connector-service's connectors.config JSONB carries
-- composioConnectedAccountId; the manifest-sync path (publish-manifest-sync
-- in tenant-runtime, fed by the connector-service composio OAuth callback)
-- copies the value over on every upsert.
--
-- Nullable because native connectors don't have one, and pre-cutover
-- legacy composio rows won't have it until the tenant reconnects. The
-- dispatcher hard-fails (composio_dispatch_missing_connection) when a
-- composio_managed call lands on a row without the field; reconnecting the
-- connector for that tenant populates it.

ALTER TABLE connector_manifests
  ADD COLUMN IF NOT EXISTS external_account_id TEXT;

COMMENT ON COLUMN connector_manifests.external_account_id IS
  'Composio composioConnectedAccountId for composio_managed connectors. NULL for native connectors and legacy rows pre-cutover.';
