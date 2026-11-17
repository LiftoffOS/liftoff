-- Bring-your-own AI provider keys: the control-plane half.
--
-- The Workspace AI selection answers WHICH provider a workspace's teams route
-- to. This table answers the separate question of WHOSE account pays for the
-- tokens: a row here is a customer's own credential with that provider, used
-- in place of the Liftoff-managed pool whenever a call resolves to it.
--
-- The secret itself is NOT here. It goes to Secret Manager, one secret per
-- tenant + vendor, the same custody the per-connector credentials already use.
-- What lives in the database is the pointer (`secret_name`), the redaction the
-- settings card reads back (`hint`), and whether the provider still honours it
-- (`status`). A credential is write-only from the browser's point of view: it is
-- accepted once and never returned.
--
-- The four vendors do not all issue the same KIND of credential, which is why
-- nothing here names one. Anthropic, OpenAI and xAI hand out an opaque key.
-- Google does not: a customer's Google AI capacity lives in their own Vertex AI
-- project, and the credential is a SERVICE ACCOUNT — a project, a location and a
-- key pair. It is never sent as a credential at all; the gateway exchanges it
-- for a short-lived OAuth token per request, so the key pair stays in Secret
-- Manager and access continues for as long as the customer leaves it in place.
--
-- `vendor` is `xai`, not the `grok` that WORKSPACE_AI_VENDORS uses. That list
-- names the model brand a workspace routes to and Grok reaches us through
-- OpenRouter; this one names the account a key belongs to. The two
-- vocabularies are deliberately not merged.
--
-- `status` has exactly two members and no `unverified`. Every key is checked
-- against its provider before it is stored and a write that fails is rejected
-- whole, so nothing unchecked is ever in here. `revoked` is what a key that
-- WAS valid decays into once it is revoked at the provider, expires, or hits a
-- spend cap; the signal arrives from a runtime 401, never from a user action.
--
-- Primary key is (tenant_id, vendor) rather than a surrogate id: one key per
-- provider per workspace is the whole model, and the uniqueness that enforces
-- it is also the identity every read and every merge write addresses a row by.

CREATE TABLE tenant_ai_provider_keys (
  tenant_id        UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  vendor           TEXT        NOT NULL
    CHECK (vendor IN ('anthropic', 'google', 'openai', 'xai')),
  -- Secret Manager entry holding the raw key. `ai-provider-key-{tenantId}-{vendor}`,
  -- in the project resolveSecretProjectId() picks for this tenant's hosting mode.
  secret_name      TEXT        NOT NULL,
  -- What the card shows in the field when it is reopened. Its job is to say
  -- WHICH credential is stored, and the two credential kinds do that
  -- differently.
  --
  -- For a key: six leading characters, eight literal bullets, four trailing
  -- characters — `sk-ant••••••••3f2x`. The head is the vendor's own prefix,
  -- identical across every key that vendor issues; the tail distinguishes one of
  -- the customer's own keys from another. The interior is the secret and never
  -- appears here, and the bullet run is a fixed width so the hint does not
  -- disclose the key's length.
  --
  -- For a Vertex service account: the account's own address. It does the same
  -- job and discloses nothing — the email is on the customer's own IAM page, and
  -- the secret half is the private key, which never leaves the control plane.
  hint             TEXT        NOT NULL,
  status           TEXT        NOT NULL DEFAULT 'valid'
    CHECK (status IN ('valid', 'revoked')),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- Last time the provider itself confirmed the key works, at save or from a
  -- later runtime call. Not displayed today; it is what makes a stale 'valid'
  -- diagnosable. NULL only in the window between a revocation and a replacement.
  last_verified_at TIMESTAMPTZ,

  PRIMARY KEY (tenant_id, vendor)
);

ALTER TABLE tenant_ai_provider_keys ENABLE ROW LEVEL SECURITY;
ALTER TABLE tenant_ai_provider_keys FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON tenant_ai_provider_keys
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

COMMENT ON TABLE tenant_ai_provider_keys IS
  'Customer-supplied provider credentials (BYOK). The secret lives in Secret Manager; this table holds the pointer, the redaction the settings card reads back, and whether the provider still honours the key.';
