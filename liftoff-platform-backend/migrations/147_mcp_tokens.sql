-- MCP-only tokens.
-- liftoff_mcp_* prefix tokens — valid on /mcp only (not /proxy).
-- Issued by `liftoff collab` CLI command for developers who want collaboration
-- tools without the Anthropic proxy.

CREATE TABLE mcp_tokens (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID        NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  account_id     UUID        NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  token_hash     TEXT        NOT NULL,
  token_prefix   TEXT        NOT NULL,
  name           TEXT        NOT NULL DEFAULT 'Default',
  status         TEXT        NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'revoked')),
  last_used_at   TIMESTAMPTZ,
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '365 days',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  deleted_at     TIMESTAMPTZ
);

CREATE UNIQUE INDEX idx_mcp_tokens_hash
  ON mcp_tokens (token_hash) WHERE deleted_at IS NULL;

CREATE INDEX idx_mcp_tokens_tenant
  ON mcp_tokens (tenant_id) WHERE deleted_at IS NULL;

CREATE INDEX idx_mcp_tokens_account
  ON mcp_tokens (account_id) WHERE deleted_at IS NULL;
