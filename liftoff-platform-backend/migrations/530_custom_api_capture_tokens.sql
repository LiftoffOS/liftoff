-- Migration 530: the capture link for a custom API connection.
--
-- An assistant meets a service the workspace wants and there is no connector
-- for it. The conversation can now finish the job: read the provider's own
-- documentation, describe the connection, and hand the person a LINK to enter
-- the credential. This is the row behind that link.
--
-- The value never enters the conversation. What travels is a token whose HASH
-- is stored here; the page it opens posts the credential to an authenticated
-- endpoint, which hands it to connector-service, which writes Secret Manager.
--
-- SIXTY MINUTES, not ten: the person may have to go and create a key at the
-- provider first, and a link that expires while they are doing that is a link
-- that sends them back to the assistant to ask for another one.
--
-- WHO MAY COMPLETE ONE: any member with `connections:manage`. The token is
-- scoped to the TENANT and the SPEC HASH, not to the account that asked, so
-- the person who asked can hand the link to the colleague who actually holds
-- the key. Scoping it to the requester reads as safer and is not: the
-- requester is frequently not the key holder, so the key would travel to them
-- over Slack or email to be pasted, which puts the secret back into a
-- conversation — the one thing this feature exists to prevent. What makes the
-- wider scope safe is that the page discloses nothing (there is no stored
-- value to read), that permission is re-checked at SUBMIT rather than at mint,
-- that the completing account is recorded on the connection, and that the
-- token stays single use so a link in a thread is spent the moment it is used.
--
-- `attempt_id` is minted HERE and sent to connector-service, which keys
-- creation on it. A platform-backend-only claim is not enough: if
-- connector-service creates the connector and the response is lost, a retry
-- with the same token would ask it to create a second one. Keyed on the
-- attempt id, the retry gets the first connector back instead. The idempotency
-- has to run end to end or it only moves the duplicate one service along.
--
-- `connector_id` stays NULL until connector-service returns one — platform
-- backend cannot record a connector id at claim time, because connector-service
-- owns connector-id creation and has not been called yet.
--
-- Tenant data, so RLS and FORCE RLS as every tenant table here. The session
-- variable is `app.current_tenant_id` (this repo's), not connector-service's
-- `app.tenant_id`.

CREATE TABLE IF NOT EXISTS custom_api_capture_tokens (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id           UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  -- sha256 of the token the link carries. The token itself is never stored,
  -- the same discipline src/oauth/device-router.ts applies to a device code.
  token_hash          TEXT NOT NULL UNIQUE,
  -- Who asked for the link. Recorded so the person who asked can be told who
  -- finished it; NOT who is allowed to finish it.
  requested_by_account_id UUID NOT NULL,
  -- The declared connection description the assistant produced, as the capture
  -- page renders it and as connector-service receives it. Never a credential.
  spec                JSONB NOT NULL,
  -- sha256 of the canonical form of `spec`. The token is bound to it, so a
  -- link cannot be replayed against a different description than the one the
  -- person was shown.
  spec_hash           TEXT NOT NULL,
  -- Minted at mint time, carried to connector-service on the submit, and the
  -- key its creation is idempotent on.
  attempt_id          UUID NOT NULL DEFAULT gen_random_uuid(),
  -- A reconnect keeps the connector id, so every bound team recovers at once.
  -- NULL for a first connection.
  reconnect_connector_id UUID,
  -- Single use. Stamped by the atomic claim, which is what makes a second
  -- submit resolve rather than duplicate.
  claimed_at          TIMESTAMPTZ,
  claimed_by_account_id UUID,
  -- Written back once connector-service has returned a connector id. A claim
  -- with none and a live attempt is in flight; a claim with none and a dead
  -- attempt is re-driven against the SAME attempt id.
  connector_id        UUID,
  expires_at          TIMESTAMPTZ NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_custom_api_capture_tokens_tenant
  ON custom_api_capture_tokens (tenant_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_custom_api_capture_tokens_expiry
  ON custom_api_capture_tokens (expires_at);

ALTER TABLE custom_api_capture_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE custom_api_capture_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON custom_api_capture_tokens
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMENT ON TABLE custom_api_capture_tokens IS
  'The capture link behind a custom API connection: a hashed single-use token, sixty-minute TTL, bound to the tenant and to a hash of the declared connection description. Carries the attempt id connector-service keys creation on, and the connector id written back once it returns one. Never holds a credential.';
