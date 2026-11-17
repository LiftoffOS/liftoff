-- Claude Code Proxy Keys
-- Maps Liftoff-issued proxy keys (liftoff_sk_*) to real Anthropic API keys
-- stored in GCP Secret Manager. Each member creates their own key(s).

CREATE TABLE IF NOT EXISTS claude_code_proxy_keys (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id),
  account_id            UUID NOT NULL REFERENCES accounts(id),
  key_hash              TEXT NOT NULL,           -- SHA-256 of full liftoff_sk_* token
  key_prefix            TEXT NOT NULL,           -- 'liftoff_sk_' + first 8 chars of random portion
  key_hint              TEXT NOT NULL,           -- last 4 chars for UI display
  anthropic_secret_name TEXT NOT NULL,           -- Secret Manager resource path
  name                  TEXT NOT NULL DEFAULT 'Default',
  status                TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active', 'revoked')),
  last_used_at          TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at            TIMESTAMPTZ
);

-- Hot path: every proxy request does a hash lookup
CREATE UNIQUE INDEX idx_proxy_keys_hash ON claude_code_proxy_keys (key_hash) WHERE deleted_at IS NULL;

-- Dashboard: list keys per tenant
CREATE INDEX idx_proxy_keys_tenant ON claude_code_proxy_keys (tenant_id, created_at DESC) WHERE deleted_at IS NULL;

-- My keys: list keys per account
CREATE INDEX idx_proxy_keys_account ON claude_code_proxy_keys (account_id) WHERE deleted_at IS NULL;
