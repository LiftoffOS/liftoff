-- Phase 1 security fix: PKCE setup tokens for MCP must be stored in DB (security req #14)
-- Proxy setup tokens remain in-memory for backward compatibility.

CREATE TABLE setup_tokens (
  token          TEXT        PRIMARY KEY,
  token_type     TEXT        NOT NULL CHECK (token_type IN ('proxy', 'mcp')),
  full_key       TEXT        NOT NULL,
  base_url       TEXT        NOT NULL,
  tenant_id      UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id     UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_id       TEXT,
  code_challenge TEXT,
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes',
  used_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_setup_tokens_expires
  ON setup_tokens (expires_at)
  WHERE used_at IS NULL;
