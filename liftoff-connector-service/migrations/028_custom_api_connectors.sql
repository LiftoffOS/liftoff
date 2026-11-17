-- Migration 028: custom API connectors — the per-instance description of an
-- API a workspace connected from a conversation.
--
-- One row per `custom_api_connector` instance, keyed by the connector id it
-- describes. The shared catalog gains exactly ONE generic type; everything
-- that makes a particular provider itself — its hosts, the scheme and where
-- the credential goes, the verification call, the operations generated from
-- its OpenAPI specification — lives here, in this service's own database,
-- beside the `connectors` row and under the same tenancy.
--
-- RLS FROM THIS MIGRATION, not later. platform-backend's `custom_mcp_servers`
-- is the cautionary example: it carries `tenant_id`, RLS was never enabled on
-- it, and its isolation today is a `WHERE tenant_id = $1` in the service layer
-- and nothing else. The session variable here is `app.tenant_id` (migrations
-- 001/002), NOT platform-backend's `app.current_tenant_id`.
--
-- The credential itself is NEVER here: it is a Secret Manager secret named
-- `connector-{tenantId}-{connectorId}`, written through credentialService, the
-- same custody every connector credential has. `auth_placement` records WHERE
-- the value goes (bearer header, named header, query parameter, path segment)
-- and never what it is.

BEGIN;

CREATE TABLE IF NOT EXISTS custom_api_connectors (
  connector_id            UUID        PRIMARY KEY REFERENCES connectors(id) ON DELETE CASCADE,
  tenant_id               TEXT        NOT NULL,
  name                    TEXT        NOT NULL,
  provider_slug           TEXT        NOT NULL,
  base_url                TEXT        NOT NULL,
  -- Every host this connection may reach. The executor refuses a destination
  -- outside it, which is what makes "the API the person consented to" a
  -- property of the row rather than of the specification we happened to read.
  api_hosts               TEXT[]      NOT NULL DEFAULT ARRAY[]::TEXT[],
  -- bearer_header | header | query | path — the API-key-shaped schemes. A
  -- scheme outside them is declined by name at registration, never stored.
  auth_scheme             TEXT        NOT NULL,
  auth_placement          JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- The declared read-only GET or HEAD that decides `active` vs `error`, plus
  -- the optional response field that names the external account.
  verification            JSONB       NOT NULL DEFAULT '{}'::jsonb,
  -- The generated operations: one entry per supported operation in the
  -- accepted specification, with its merged HITL classification.
  ops                     JSONB       NOT NULL DEFAULT '[]'::jsonb,
  spec_source_url         TEXT,
  spec_hash               TEXT        NOT NULL,
  spec_fetched_at         TIMESTAMPTZ,
  -- Set only once the declared verification call has actually succeeded, so
  -- "connected" can never be read as "verified" from this row alone.
  verified_at             TIMESTAMPTZ,
  -- Who entered the credential, which is not always who asked for the link.
  completed_by_account_id TEXT,
  -- The platform-backend capture attempt this row was created for. Creation is
  -- keyed on it, so a retry after a lost response returns the FIRST connector
  -- instead of creating a second one.
  attempt_id              TEXT,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS custom_api_connectors_tenant_idx
  ON custom_api_connectors (tenant_id, connector_id);

-- End-to-end idempotency for the capture submit. A platform-backend claim
-- alone is not enough: if this service creates the connector and the response
-- is lost, a retry with the same token would ask it to create a second one.
CREATE UNIQUE INDEX IF NOT EXISTS custom_api_connectors_attempt_idx
  ON custom_api_connectors (tenant_id, attempt_id)
  WHERE attempt_id IS NOT NULL;

-- Reuse the set_updated_at() trigger defined in migration 001.
DROP TRIGGER IF EXISTS custom_api_connectors_updated_at ON custom_api_connectors;
CREATE TRIGGER custom_api_connectors_updated_at
  BEFORE UPDATE ON custom_api_connectors
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

ALTER TABLE custom_api_connectors ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS custom_api_connectors_tenant_isolation ON custom_api_connectors;
CREATE POLICY custom_api_connectors_tenant_isolation ON custom_api_connectors
  USING (tenant_id = current_setting('app.tenant_id', true))
  WITH CHECK (tenant_id = current_setting('app.tenant_id', true));

-- Migration 006's grant list, extended: withAdminScope runs as connector_admin
-- (BYPASSRLS) and has no table permissions unless they are granted here.
GRANT SELECT, INSERT, UPDATE, DELETE ON TABLE custom_api_connectors TO connector_admin;

COMMENT ON TABLE custom_api_connectors IS
  'Per-instance description of an API a workspace connected from a conversation: hosts, scheme and placement, the declared verification call, and the operations generated from the provider''s OpenAPI specification. One row per custom_api_connector connector. Never holds the credential — that is a Secret Manager secret named connector-{tenantId}-{connectorId}.';

COMMIT;
