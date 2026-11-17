-- Migration 006: Capability tokens
--
-- One-use, scoped, short-lived tokens minted when a workforce plan is approved.
-- The approve handler mints a token and passes it to the HRBP agent, which
-- validates and burns it on first use to prevent replay attacks.
--
-- token_hash stores HMAC-SHA256(raw_token, CAPABILITY_TOKEN_SECRET) so the
-- raw token is never persisted. The raw token is returned to the caller once
-- and must be presented on validation.

CREATE TABLE capability_tokens (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id         UUID        NOT NULL,
  tenant_id       UUID        NOT NULL,
  account_id      UUID        NOT NULL,
  scope           TEXT        NOT NULL,
  token_hash      TEXT        NOT NULL UNIQUE,
  expires_at      TIMESTAMPTZ NOT NULL,
  used_at         TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX capability_tokens_plan_idx
  ON capability_tokens (plan_id, tenant_id);

CREATE INDEX capability_tokens_expires_idx
  ON capability_tokens (expires_at)
  WHERE used_at IS NULL;

COMMENT ON TABLE capability_tokens IS
  'One-use provisioning authority tokens. Minted on plan approval, burned on first HRBP use.';
COMMENT ON COLUMN capability_tokens.token_hash IS
  'HMAC-SHA256 of the raw token. Raw token never stored.';
COMMENT ON COLUMN capability_tokens.scope IS
  'Dot-separated action scope, e.g. hrbp.provision.plan_id.';
