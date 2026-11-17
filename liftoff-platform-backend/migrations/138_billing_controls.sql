-- Credit risk controls.
--
-- ou_pricing must be created first — billing_spend_events has a FK to it.
-- billing_controls: live running counter per account.
-- billing_spend_events: idempotency log, one row per invocation processed.
-- billing_ingest_cursors: resumable cursor table for billing ingesters.

-- ── ou_pricing ────────────────────────────────────────────────────────────────

CREATE TABLE ou_pricing (
  id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tier            TEXT NOT NULL CHECK (tier IN ('standard', 'enterprise')),
  price_per_ou    NUMERIC(10,4) NOT NULL,
  included_ous    INTEGER NOT NULL DEFAULT 0,
  effective_from  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_until TIMESTAMPTZ,
  changed_by      TEXT NOT NULL,
  change_reason   TEXT,
  created_at      TIMESTAMPTZ DEFAULT NOW(),
  UNIQUE (tier, effective_from)
);

-- Seed initial pricing rates
INSERT INTO ou_pricing (tier, price_per_ou, included_ous, changed_by, change_reason) VALUES
  ('standard',   3.00, 0, 'system', 'initial seed — Phase 0 billing controls'),
  ('enterprise', 2.50, 0, 'system', 'initial seed — Phase 0 billing controls');

-- ── billing_controls ─────────────────────────────────────────────────────────
-- One row per account. Updated by optimistic locking on every
-- invocation.completed event. stripe_subscription_id + stripe_period_start
-- are the stable idempotency anchors for threshold charge keys.

CREATE TABLE billing_controls (
  account_id                UUID PRIMARY KEY REFERENCES accounts(id),
  current_period_spend_usd  NUMERIC(18,6) NOT NULL DEFAULT 0.00,
  next_threshold_usd        NUMERIC(18,6) NOT NULL DEFAULT 100.00,
  last_threshold_charged_at TIMESTAMPTZ,
  last_card_auth_at         TIMESTAMPTZ,
  graduated_at              TIMESTAMPTZ,
  outstanding_balance_usd   NUMERIC(18,6) NOT NULL DEFAULT 0.00,
  suspended                 BOOLEAN NOT NULL DEFAULT FALSE,
  last_charge_failed_at     TIMESTAMPTZ,
  prepaid_balance_usd       NUMERIC(18,6) NOT NULL DEFAULT 0.00,
  billing_tier              TEXT NOT NULL DEFAULT 'standard'
    CHECK (billing_tier IN ('standard', 'enterprise')),
  stripe_customer_id        TEXT UNIQUE,
  stripe_subscription_id    TEXT,
  stripe_period_start       TIMESTAMPTZ,
  billing_period_start      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  spend_updated_at          TIMESTAMPTZ DEFAULT NOW(),
  created_at                TIMESTAMPTZ DEFAULT NOW(),
  updated_at                TIMESTAMPTZ DEFAULT NOW()
);

-- Fast lookup for execution guard — only suspended accounts are blocked.
CREATE INDEX idx_billing_controls_blocked
  ON billing_controls (suspended)
  WHERE suspended = TRUE;

-- Threshold-check scan: find accounts that have crossed next threshold.
CREATE INDEX idx_billing_controls_threshold
  ON billing_controls (current_period_spend_usd, next_threshold_usd);

-- ── billing_spend_events ──────────────────────────────────────────────────────
-- Idempotency log: one row per invocation. Prevents double-counting on
-- Pub/Sub redelivery. ou_pricing_id FK enables cost audit by pricing tier.

CREATE TABLE billing_spend_events (
  invocation_id  TEXT PRIMARY KEY,
  tenant_id      UUID NOT NULL,
  account_id     UUID NOT NULL,
  cost_usd       NUMERIC(12,6) NOT NULL,
  ou_spend_usd   NUMERIC(12,6) NOT NULL,
  ou_pricing_id  UUID REFERENCES ou_pricing(id),
  processed_at   TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_billing_spend_events_tenant
  ON billing_spend_events (tenant_id, processed_at);

CREATE INDEX idx_billing_spend_events_account
  ON billing_spend_events (account_id, processed_at);

-- ── billing_ingest_cursors ────────────────────────────────────────────────────

CREATE TABLE billing_ingest_cursors (
  source            TEXT PRIMARY KEY,
  last_processed_at TIMESTAMPTZ,
  last_id           TEXT,
  completed         BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at        TIMESTAMPTZ DEFAULT NOW()
);
