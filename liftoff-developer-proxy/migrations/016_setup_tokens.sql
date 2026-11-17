-- migrations/016_setup_tokens.sql
-- Durable, cross-instance setup-token store for the CLI handoff.
--
-- Replaces the process-local in-memory Map in credentials/service.ts, which was
-- lost on every proxy deploy and unreachable across instances (maxScale=20, no
-- session affinity). The dashboard mints a one-time setup token on credential
-- creation; the CLI-auth page retrieves it (pending-setup-token) and the CLI
-- exchanges it for the proxy key. All four operations must see the SAME token
-- regardless of which instance serves them, so the token lives in Postgres.
--
-- Rows are single-use (deleted on exchange) and short-lived (expires_at); the
-- full_key and setup_token are bearer secrets held only for the handoff window
-- and rely on Cloud SQL at-rest encryption + private IP, matching the prior
-- in-memory design's data exactly (nothing more sensitive is stored here; the
-- vendor API key stays in Secret Manager).

BEGIN;

CREATE TABLE developer_proxy_setup_tokens (
  setup_token    TEXT        PRIMARY KEY,
  full_key       TEXT        NOT NULL,
  proxy_base_url TEXT        NOT NULL,
  tenant_id      UUID        NOT NULL,
  user_id        TEXT        NOT NULL,
  code_challenge TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at     TIMESTAMPTZ NOT NULL
);

-- pending-setup-token: latest unexpired token for a (tenant, user).
CREATE INDEX idx_dp_setup_tokens_tenant_user
  ON developer_proxy_setup_tokens (tenant_id, user_id, created_at DESC);

-- Sweep of expired rows.
CREATE INDEX idx_dp_setup_tokens_expires
  ON developer_proxy_setup_tokens (expires_at);

GRANT SELECT, INSERT, UPDATE, DELETE ON developer_proxy_setup_tokens TO developer_proxy_app;

COMMIT;
