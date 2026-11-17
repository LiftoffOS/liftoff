-- Migration 218: Custom Event Sources (per-agent inbound webhooks)
--
-- Adds the persistence layer for "Open ingestion, closed execution" — external
-- systems POST to a per-source URL, the platform routes the event to one or
-- more internal agents, and the tenant-runtime executor applies a stricter
-- approval policy because trust originated outside the workspace.
--
-- Data model:
--
--   event_sources                — one row per webhook URL (created lazily on
--                                  first "Enable webhook" click). Holds the
--                                  URL token, AES-256-GCM-encrypted signing
--                                  secret, and per-source operator settings.
--   event_trigger_rules          — many-to-many between event_sources and
--                                  internal_agents.
--   event_deliveries             — append-only audit log of every inbound HTTP
--                                  call.
--   event_source_audit_log       — administrative actions (created / enabled
--                                  / disabled / credentials_reset /
--                                  settings_updated / deleted) keyed by
--                                  source_id. Captures actor_user_id.
--   event_source_rate_limit_events
--                                — per-request ledger powering the atomic
--                                  rate-limit check (mirrors
--                                  insights_rate_limit_events pattern from
--                                  migration 074). Decoupled from
--                                  event_deliveries so DSAR-driven deletes
--                                  don't shrink the limit window.
--   tenant_webhook_caps          — per-tenant ceiling (requests/minute across
--                                  all sources) and optional daily run-
--                                  dispatch budget.
--
-- Secret storage:
--   event_sources.signing_secret_ciphertext is the AES-256-GCM envelope
--   produced by src/event-sources/secret-encryption.ts. The master key lives
--   in Secret Manager under `event-source-encryption-key`. Plaintext never
--   touches disk and is only returned to the UI at provision/reset time.
--
-- RLS: every tenant-scoped table sets tenant_id and enables RLS with the
-- standard policy. Migration 095 / 200 enable RLS via a DO-loop on any table
-- with a tenant_id column; we still ENABLE explicitly here so this migration
-- is self-contained and works if applied before a later 095-style sweep.

-- ============================================================================
-- event_sources
-- ============================================================================

CREATE TABLE event_sources (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name TEXT NOT NULL,                          -- user-facing label, defaults to "<agent name> webhook"
  url_token TEXT NOT NULL UNIQUE,              -- 32 random bytes, base64url; identifies the source in the public URL
  hmac_required BOOLEAN NOT NULL DEFAULT TRUE,
  -- AES-256-GCM envelope: [version:1B][iv:12B][authTag:16B][ciphertext:N].
  -- See src/event-sources/secret-encryption.ts for the codec. Plaintext is
  -- 32 bytes hex-encoded, so ciphertext for a fresh secret is 1+12+16+64 = 93 bytes.
  signing_secret_ciphertext BYTEA NOT NULL,
  signing_secret_hint TEXT NOT NULL,           -- last 4 chars of the plaintext, for the UI hint ("...a1b2")
  enabled BOOLEAN NOT NULL DEFAULT FALSE,      -- pause-style: FALSE = paused, row persists, inbound 404s
  rate_limit_per_minute INT NOT NULL DEFAULT 120,
  max_payload_bytes INT NOT NULL DEFAULT 1048576,
  content_filter_enabled BOOLEAN NOT NULL DEFAULT TRUE,
  pii_hash_mode BOOLEAN NOT NULL DEFAULT FALSE,    -- when TRUE, request_body is NULL and only request_body_sha256 is stored
  last_event_at TIMESTAMPTZ,
  last_reset_at TIMESTAMPTZ,                   -- last time credentials (URL + secret) were rewritten
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX event_sources_tenant ON event_sources(tenant_id);

ALTER TABLE event_sources ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_event_sources ON event_sources;
CREATE POLICY tenant_isolation_event_sources ON event_sources
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ============================================================================
-- event_trigger_rules
-- ============================================================================

CREATE TABLE event_trigger_rules (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  source_id UUID NOT NULL REFERENCES event_sources(id) ON DELETE CASCADE,
  event_type_pattern TEXT NOT NULL DEFAULT '*',
  agent_id UUID NOT NULL REFERENCES internal_agents(id) ON DELETE CASCADE,
  enabled BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX event_trigger_rules_source ON event_trigger_rules(source_id);
CREATE INDEX event_trigger_rules_agent ON event_trigger_rules(agent_id);

ALTER TABLE event_trigger_rules ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_event_trigger_rules ON event_trigger_rules;
CREATE POLICY tenant_isolation_event_trigger_rules ON event_trigger_rules
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ============================================================================
-- event_deliveries
-- ============================================================================

CREATE TABLE event_deliveries (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES event_sources(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  event_id TEXT,                               -- from envelope OR Idempotency-Key header OR sha256(body)
  event_type TEXT,                             -- from envelope; synthesized as 'webhook.received' when absent
  request_headers JSONB,                       -- filtered: drops authorization/cookie/x-liftoff-signature; per-value cap 4 KB
  request_body BYTEA,                          -- NULL when source.pii_hash_mode = TRUE
  request_body_bytes INT NOT NULL DEFAULT 0,   -- original payload size in bytes; preserved even when request_body is NULL
  request_body_sha256 TEXT,                    -- always populated for dedup/forensic identification
  signature TEXT,
  signature_valid BOOLEAN NOT NULL,
  status TEXT NOT NULL,                        -- accepted | duplicate | dispatch_failed | rejected_signature | rejected_rate |
                                               -- rejected_size | rejected_disabled | rejected_no_active_rule |
                                               -- rejected_unsafe_content | rejected_tenant_ceiling | rejected_budget_exceeded
  unsafe_content_matches TEXT[] NOT NULL DEFAULT '{}',
  content_redacted BOOLEAN NOT NULL DEFAULT FALSE,
  matched_rule_ids UUID[] NOT NULL DEFAULT '{}',
  outbox_event_ids UUID[] NOT NULL DEFAULT '{}',
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE UNIQUE INDEX event_deliveries_idem ON event_deliveries(source_id, event_id) WHERE event_id IS NOT NULL;
CREATE INDEX event_deliveries_recent ON event_deliveries(source_id, received_at DESC);
CREATE INDEX event_deliveries_purge ON event_deliveries(received_at);
CREATE INDEX event_deliveries_sha256 ON event_deliveries(request_body_sha256)
  WHERE request_body_sha256 IS NOT NULL;   -- DSAR purge lookups

ALTER TABLE event_deliveries ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_event_deliveries ON event_deliveries;
CREATE POLICY tenant_isolation_event_deliveries ON event_deliveries
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ============================================================================
-- event_source_audit_log
-- ============================================================================

CREATE TABLE event_source_audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id UUID NOT NULL REFERENCES event_sources(id) ON DELETE CASCADE,
  tenant_id UUID NOT NULL,
  action TEXT NOT NULL,                        -- created | enabled | disabled | credentials_reset | settings_updated | deleted | caps_updated
  actor_user_id UUID,                          -- account.id from the management call
  metadata JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX event_source_audit_log_source ON event_source_audit_log(source_id, created_at DESC);

ALTER TABLE event_source_audit_log ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_event_source_audit_log ON event_source_audit_log;
CREATE POLICY tenant_isolation_event_source_audit_log ON event_source_audit_log
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ============================================================================
-- event_source_rate_limit_events
--
-- Dedicated ledger powering the per-source and per-tenant rate-limit
-- check-and-increment. Mirrors the shape required by
-- src/common/chat-rate-limiter.ts (id, tenant_id, account_id, created_at).
-- We borrow account_id as the source_id slot — different "subject" per row
-- but identical schema, which lets us reuse the atomic CTE in the shared
-- rate-limiter.
-- ============================================================================

CREATE TABLE event_source_rate_limit_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL,
  account_id UUID NOT NULL,        -- repurposed: event_sources.id of the source being throttled
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX event_source_rate_limit_events_tenant_time
  ON event_source_rate_limit_events(tenant_id, created_at DESC);
CREATE INDEX event_source_rate_limit_events_source_time
  ON event_source_rate_limit_events(account_id, created_at DESC);
CREATE INDEX event_source_rate_limit_events_purge
  ON event_source_rate_limit_events(created_at);

ALTER TABLE event_source_rate_limit_events ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_event_source_rate_limit_events ON event_source_rate_limit_events;
CREATE POLICY tenant_isolation_event_source_rate_limit_events ON event_source_rate_limit_events
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ============================================================================
-- tenant_webhook_caps
-- ============================================================================

CREATE TABLE tenant_webhook_caps (
  tenant_id UUID PRIMARY KEY REFERENCES tenants(id) ON DELETE CASCADE,
  max_requests_per_minute INT NOT NULL DEFAULT 1000,    -- across all sources combined
  daily_run_budget INT,                                  -- nullable = unlimited; cap on dispatched runs/day
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

ALTER TABLE tenant_webhook_caps ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation_tenant_webhook_caps ON tenant_webhook_caps;
CREATE POLICY tenant_isolation_tenant_webhook_caps ON tenant_webhook_caps
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
