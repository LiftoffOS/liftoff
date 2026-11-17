-- Migration 004: tenant_oversight_cache
--
-- Local cache of tenant oversight settings, populated by the
-- oversight-subscriber via Pub/Sub events from platform-backend.
-- Queried by hitl-enforcement service.getOversightSettings() on
-- every Preflight and Authorize call.
--
-- NOTE: The service role (governance_app) uses pool directly with
-- BYPASSRLS, so tenant isolation is enforced via WHERE tenant_id = $1.

CREATE TABLE IF NOT EXISTS tenant_oversight_cache (
  tenant_id      TEXT         PRIMARY KEY,
  entity_version INTEGER      NOT NULL DEFAULT 1,
  autonomy       TEXT         NOT NULL DEFAULT 'balanced',
  escalation     TEXT         NOT NULL DEFAULT 'important',
  sensitive_work JSONB        NOT NULL DEFAULT '{}'::jsonb,
  communication  TEXT         NOT NULL DEFAULT 'review',
  synced_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_tenant_oversight_cache_synced_at
  ON tenant_oversight_cache (synced_at DESC);
