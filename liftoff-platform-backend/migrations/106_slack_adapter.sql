-- Migration 106: Slack adapter — per-agent Slack app management
--
-- Creates tables for managing per-agent Slack apps (created via
-- apps.manifest.create), Slack user → platform account mappings,
-- and event deduplication.
--
-- Part of Phase 3 of the Interactive Mode implementation plan.

-- ============================================================================
-- 1. Agent Slack apps (one per agent, managed via Manifest API)
-- ============================================================================

CREATE TABLE agent_slack_apps (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  agent_id UUID NOT NULL REFERENCES internal_agents(id),
  -- Returned by apps.manifest.create:
  slack_app_id TEXT NOT NULL,
  slack_client_id TEXT NOT NULL,
  slack_client_secret_ref TEXT NOT NULL,   -- Secret Manager secret version path
  slack_signing_secret_ref TEXT NOT NULL,  -- Secret Manager secret version path
  -- Populated after workspace admin completes OAuth install:
  slack_team_id TEXT,
  slack_bot_user_id TEXT,
  slack_bot_token_ref TEXT,               -- Secret Manager secret version path
  install_status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (install_status IN ('pending', 'installed', 'revoked', 'error')),
  installed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  -- One Slack app per agent per tenant
  UNIQUE (tenant_id, agent_id),
  -- Global uniqueness on Slack app ID (Slack enforces this too)
  UNIQUE (slack_app_id)
);

-- Fast lookup by Slack app ID (webhook handler uses this on every event)
CREATE INDEX idx_asa_lookup ON agent_slack_apps (slack_app_id)
  WHERE install_status = 'installed';

-- Pending installs dashboard: list all agents awaiting Slack installation
CREATE INDEX idx_asa_pending ON agent_slack_apps (tenant_id, install_status)
  WHERE install_status = 'pending';

ALTER TABLE agent_slack_apps ENABLE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_slack_apps
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ============================================================================
-- 2. Slack user → platform account cache
-- ============================================================================

-- When a Slack event arrives, we know the Slack user ID but need the
-- platform account_id. This cache avoids calling Slack users.info + DB
-- lookup on every message. Entries are refreshed on cache miss.
CREATE TABLE slack_user_mappings (
  slack_team_id TEXT NOT NULL,
  slack_user_id TEXT NOT NULL,
  account_id UUID REFERENCES accounts(id),
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  slack_email TEXT,
  cached_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (slack_team_id, slack_user_id)
);

-- ============================================================================
-- 3. Slack event deduplication
-- ============================================================================

-- Slack retries event deliveries if no 200 response within 3 seconds.
-- This table stores event_id for dedup. Cleaned by scheduled job (5-min TTL).
CREATE TABLE slack_event_dedup (
  event_id TEXT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_sed_ttl ON slack_event_dedup (received_at);
