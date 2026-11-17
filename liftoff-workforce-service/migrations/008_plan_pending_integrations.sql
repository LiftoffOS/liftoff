-- Migration 008: Plan pending integrations
--
-- Tracks agent specs that are waiting for the tenant to complete an OAuth
-- flow before the connector can be linked. When the callback arrives, the
-- resolver validates the HMAC state and marks the row resolved, then resumes
-- the paused provisioning run.
--
-- oauth_state_hmac: HMAC-SHA256(plan_id || tenant_id || account_id || nonce,
--   PENDING_INTEGRATION_STATE_SECRET). Validated on callback arrival.

CREATE TABLE plan_pending_integrations (
  id                 UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id            UUID        NOT NULL,
  tenant_id          UUID        NOT NULL,
  account_id         UUID        NOT NULL,
  spec_id            TEXT        NOT NULL,
  connector_type     TEXT        NOT NULL,
  oauth_state_hmac   TEXT        NOT NULL UNIQUE,
  nonce              TEXT        NOT NULL,
  expires_at         TIMESTAMPTZ NOT NULL,
  resolved_at        TIMESTAMPTZ,
  connector_id       UUID,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Only one pending entry per (plan, spec, connector) at a time.
  UNIQUE (plan_id, spec_id, connector_type)
);

CREATE INDEX pending_integrations_hmac_idx
  ON plan_pending_integrations (oauth_state_hmac)
  WHERE resolved_at IS NULL;

CREATE INDEX pending_integrations_plan_idx
  ON plan_pending_integrations (plan_id, tenant_id)
  WHERE resolved_at IS NULL;

CREATE INDEX pending_integrations_expires_idx
  ON plan_pending_integrations (expires_at)
  WHERE resolved_at IS NULL;

COMMENT ON TABLE plan_pending_integrations IS
  'Agent spec connectors awaiting OAuth completion. Pauses provisioning until resolved.';
COMMENT ON COLUMN plan_pending_integrations.oauth_state_hmac IS
  'HMAC-SHA256 of (plan_id || tenant_id || account_id || nonce) used as OAuth state parameter.';
