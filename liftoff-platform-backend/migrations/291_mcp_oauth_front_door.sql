-- Migration 291: MCP-native OAuth front door + durable chat runs
--
-- 1. mcp_tokens gains auth_kind so a credential-less OAuth anchor row can
--    exist (147 required token_hash/token_prefix NOT NULL).
-- 2. OAuth authorization-server tables: clients (platform-global),
--    authorization requests (pre-tenant), grants + codes + access + refresh
--    (tenant-scoped, RLS+FORCE, composite FKs for tenant consistency).
-- 3. Durable MCP chat runs (tenant-scoped, RLS+FORCE).
-- 4. agent_chat_threads channel CHECK widened with 'mcp' (275 pattern).
--
-- Admin-role access for the new tables comes from migration 288's default
-- privileges — verify `admin_pool_probe_ok` in logs after this deploys.

-- ============================================================================
-- 1. mcp_tokens: OAuth-only anchor support
-- ============================================================================

ALTER TABLE mcp_tokens ADD COLUMN auth_kind TEXT NOT NULL DEFAULT 'static'
  CHECK (auth_kind IN ('static', 'oauth'));
ALTER TABLE mcp_tokens ALTER COLUMN token_hash DROP NOT NULL;
ALTER TABLE mcp_tokens ALTER COLUMN token_prefix DROP NOT NULL;
-- Bidirectional: static rows MUST have credentials, oauth rows MUST NOT.
ALTER TABLE mcp_tokens ADD CONSTRAINT mcp_tokens_auth_kind_credentials CHECK (
  (auth_kind = 'static' AND token_hash IS NOT NULL AND token_prefix IS NOT NULL) OR
  (auth_kind = 'oauth'  AND token_hash IS NULL     AND token_prefix IS NULL));
-- Composite-FK target for tenant-consistency FKs below.
ALTER TABLE mcp_tokens ADD CONSTRAINT mcp_tokens_id_tenant_unique UNIQUE (id, tenant_id);
-- The existing unique index idx_mcp_tokens_hash (token_hash) WHERE deleted_at
-- IS NULL is unaffected: unique indexes treat NULLs as distinct, so any number
-- of NULL-hash oauth anchors coexist.

-- ============================================================================
-- 2a. OAuth clients (DCR registrations) — platform-global, NON-RLS
-- ============================================================================

CREATE TABLE oauth_clients (
  client_id      TEXT PRIMARY KEY,
  client_name    TEXT NOT NULL,
  -- Entries: { "uri": string, "loopback_port_wildcard": boolean }
  redirect_uris  JSONB NOT NULL,
  token_endpoint_auth_method TEXT NOT NULL DEFAULT 'none'
                 CHECK (token_endpoint_auth_method = 'none'),
  grant_types    JSONB NOT NULL DEFAULT '["authorization_code","refresh_token"]',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  last_used_at   TIMESTAMPTZ
);

-- ============================================================================
-- 2b. Pending /authorize → consent handoff — pre-tenant, NON-RLS
-- ============================================================================

CREATE TABLE oauth_authorization_requests (
  request_id     TEXT PRIMARY KEY,
  client_id      TEXT NOT NULL REFERENCES oauth_clients(client_id) ON DELETE CASCADE,
  redirect_uri   TEXT NOT NULL,
  state          TEXT,
  code_challenge TEXT NOT NULL,
  resource       TEXT NOT NULL,
  scope          TEXT NOT NULL DEFAULT 'mcp',
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes',
  consumed_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_oauth_authz_requests_expiry
  ON oauth_authorization_requests (expires_at) WHERE consumed_at IS NULL;

-- ============================================================================
-- 2c. Grants — the (client, account, tenant, anchor, resource) join point
-- ============================================================================

CREATE TABLE oauth_grants (
  id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id      UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  client_id      TEXT NOT NULL REFERENCES oauth_clients(client_id),
  account_id     UUID NOT NULL REFERENCES accounts(id) ON DELETE CASCADE,
  mcp_token_id   UUID NOT NULL,
  resource       TEXT NOT NULL,
  scope          TEXT NOT NULL DEFAULT 'mcp',
  status         TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'revoked')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at     TIMESTAMPTZ,
  -- Tenant-consistent anchor reference.
  FOREIGN KEY (mcp_token_id, tenant_id) REFERENCES mcp_tokens (id, tenant_id),
  -- Composite-FK target for the child tables.
  UNIQUE (id, tenant_id)
);

-- One active grant per (client, account, tenant, resource) tuple.
CREATE UNIQUE INDEX idx_oauth_grants_active_tuple
  ON oauth_grants (client_id, account_id, tenant_id, resource) WHERE status = 'active';
CREATE INDEX idx_oauth_grants_anchor ON oauth_grants (mcp_token_id);

-- ============================================================================
-- 2d. Authorization codes / access tokens / refresh tokens — RLS children
-- ============================================================================

CREATE TABLE oauth_authorization_codes (
  code_hash      TEXT PRIMARY KEY,
  grant_id       UUID NOT NULL,
  tenant_id      UUID NOT NULL,
  redirect_uri   TEXT NOT NULL,
  code_challenge TEXT NOT NULL,
  resource       TEXT NOT NULL,
  expires_at     TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '10 minutes',
  used_at        TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (grant_id, tenant_id) REFERENCES oauth_grants (id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX idx_oauth_codes_expiry ON oauth_authorization_codes (expires_at) WHERE used_at IS NULL;

CREATE TABLE oauth_access_tokens (
  token_hash     TEXT PRIMARY KEY,
  grant_id       UUID NOT NULL,
  tenant_id      UUID NOT NULL,
  resource       TEXT NOT NULL,
  scope          TEXT NOT NULL DEFAULT 'mcp',
  expires_at     TIMESTAMPTZ NOT NULL,
  revoked_at     TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (grant_id, tenant_id) REFERENCES oauth_grants (id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX idx_oauth_access_tokens_grant ON oauth_access_tokens (grant_id);
CREATE INDEX idx_oauth_access_tokens_expiry ON oauth_access_tokens (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE oauth_refresh_tokens (
  token_hash        TEXT PRIMARY KEY,
  grant_id          UUID NOT NULL,
  tenant_id         UUID NOT NULL,
  client_id         TEXT NOT NULL,
  resource          TEXT NOT NULL,
  scope             TEXT NOT NULL DEFAULT 'mcp',
  expires_at        TIMESTAMPTZ NOT NULL,
  rotated_at        TIMESTAMPTZ,
  replaced_by_hash  TEXT,
  revoked_at        TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  FOREIGN KEY (grant_id, tenant_id) REFERENCES oauth_grants (id, tenant_id) ON DELETE CASCADE
);

CREATE INDEX idx_oauth_refresh_tokens_grant ON oauth_refresh_tokens (grant_id);
-- Rotation tombstones (rotated_at set) are retained until their ORIGINAL
-- expires_at — replay detection lives exactly that long. Cleanup deletes only
-- rows past expiry.
CREATE INDEX idx_oauth_refresh_tokens_expiry ON oauth_refresh_tokens (expires_at);

-- ============================================================================
-- 3. Durable MCP chat runs
-- ============================================================================

-- Composite-FK target MUST exist before mcp_chat_runs references it
-- (audit BUG-1: Postgres rejects a composite FK with no matching unique
-- constraint at table-creation time).
ALTER TABLE agent_chat_threads ADD CONSTRAINT agent_chat_threads_id_tenant_unique UNIQUE (id, tenant_id);

CREATE TABLE mcp_chat_runs (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id             UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  anchor_token_id       UUID NOT NULL,
  thread_id             UUID NOT NULL,
  agent_id              UUID NOT NULL,
  status                TEXT NOT NULL DEFAULT 'queued'
                        CHECK (status IN ('queued', 'running', 'completed', 'waiting_on_human', 'failed')),
  user_message          TEXT NOT NULL,
  assistant_message_id  UUID REFERENCES agent_chat_messages(id),
  approval_id           TEXT,
  error_code            TEXT,
  lease_expires_at      TIMESTAMPTZ,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at          TIMESTAMPTZ,
  FOREIGN KEY (anchor_token_id, tenant_id) REFERENCES mcp_tokens (id, tenant_id),
  FOREIGN KEY (thread_id, tenant_id) REFERENCES agent_chat_threads (id, tenant_id)
);

-- One active run per thread, DB-enforced (waiting_on_human is TERMINAL and
-- deliberately absent — the thread frees immediately for follow-up turns).
CREATE UNIQUE INDEX idx_mcp_chat_runs_one_active_per_thread
  ON mcp_chat_runs (thread_id) WHERE status IN ('queued', 'running');
CREATE INDEX idx_mcp_chat_runs_anchor ON mcp_chat_runs (anchor_token_id, created_at DESC);
CREATE INDEX idx_mcp_chat_runs_sweep ON mcp_chat_runs (status, lease_expires_at)
  WHERE status IN ('queued', 'running');
-- Serves the thread-list source-label LATERAL join (latest run per thread).
CREATE INDEX idx_mcp_chat_runs_thread_recency ON mcp_chat_runs (thread_id, created_at DESC);

-- ============================================================================
-- 4. Channel CHECK widening (migration-275 pattern)
-- ============================================================================

ALTER TABLE agent_chat_threads DROP CONSTRAINT agent_chat_threads_channel_check;
ALTER TABLE agent_chat_threads ADD CONSTRAINT agent_chat_threads_channel_check
  CHECK (channel IN ('web', 'slack', 'teams', 'mcp'));

-- ============================================================================
-- 5. RLS: ENABLE + FORCE + tenant policy on the five tenant-scoped tables
-- ============================================================================

ALTER TABLE oauth_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_grants FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oauth_grants
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

ALTER TABLE oauth_authorization_codes ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_authorization_codes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oauth_authorization_codes
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

ALTER TABLE oauth_access_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_access_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oauth_access_tokens
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

ALTER TABLE oauth_refresh_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_refresh_tokens FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oauth_refresh_tokens
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

ALTER TABLE mcp_chat_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE mcp_chat_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON mcp_chat_runs
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
