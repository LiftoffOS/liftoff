-- ── OU-native columns + three per-tenant rate columns on billing_controls ─────
ALTER TABLE billing_controls
  ADD COLUMN plan_included_ous          BIGINT        NOT NULL DEFAULT 0,
  ADD COLUMN precommit_extra_ous        BIGINT        NOT NULL DEFAULT 0,
  ADD COLUMN included_rate_usd_per_ou       NUMERIC(10,6) NOT NULL DEFAULT 0,
  ADD COLUMN precommit_rate_usd_per_ou  NUMERIC(10,6) NOT NULL DEFAULT 0,
  ADD COLUMN reload_rate_usd_per_ou     NUMERIC(10,6) NOT NULL DEFAULT 0,
  ADD COLUMN ous_consumed_this_period   NUMERIC(18,3) NOT NULL DEFAULT 0,
  ADD CONSTRAINT billing_controls_consumed_nonneg CHECK (ous_consumed_this_period >= 0);

-- ── plan_catalog: canonical pricing for SELF-SERVE plans ONLY (Core/Growth/Scale).
-- Enterprise is intentionally NOT in this table — every Enterprise contract is bespoke,
-- and the three rates plus included/precommit OUs are written directly to billing_controls
-- at provision time by /api/internal/provision-enterprise. billing_controls is the canonical
-- per-tenant rate ledger; plan_catalog only seeds self-serve subscriptions.
CREATE TABLE plan_catalog (
  id                          TEXT PRIMARY KEY CHECK (id IN ('core','growth','scale')),
  display_name                TEXT NOT NULL,
  base_price_usd_cents        BIGINT NOT NULL,
  included_ous                BIGINT NOT NULL,
  included_rate_usd_per_ou    NUMERIC(10,6) NOT NULL,
  precommit_rate_usd_per_ou   NUMERIC(10,6) NOT NULL,
  reload_rate_usd_per_ou      NUMERIC(10,6) NOT NULL,
  effective_from              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  effective_to                TIMESTAMPTZ
);
INSERT INTO plan_catalog
  (id,       display_name, base_price_usd_cents, included_ous, included_rate_usd_per_ou, precommit_rate_usd_per_ou, reload_rate_usd_per_ou)
VALUES
  ('core',   'Core',       2000,                 800,          0.025000,                 0.028000,                  0.031250),
  ('growth', 'Growth',     5000,                 2150,         0.023256,                 0.028000,                  0.031250),
  ('scale',  'Scale',      20000,                9200,         0.021739,                 0.028000,                  0.031250);

-- ou_definition_rate_usd is global (same for every tenant — "1 OU = 1¢ of underlying
-- compute" is a platform-wide definition, not a contract term). Stored in a separate
-- single-row settings table to avoid polluting plan_catalog with a global constant.
CREATE TABLE billing_system_settings (
  key   TEXT PRIMARY KEY,
  value NUMERIC(18,6) NOT NULL
);
INSERT INTO billing_system_settings (key, value) VALUES
  ('ou_definition_rate_usd', 0.01);

-- ── enterprise_contracts: per-account negotiated rates + allotments. The source
-- of truth that /provision-enterprise reads from. Admin endpoint manages rows here.
-- stripe_billed splits two cases that look identical to /insights but diverge in
-- Stripe behavior:
--   TRUE  → /provision-enterprise creates a paid Stripe subscription whose
--           monthly price = included_ous*included_rate + precommit_extra_ous*precommit_rate.
--           Used for real paying Enterprise customers.
--   FALSE → /provision-enterprise creates a $0 ad-hoc Stripe subscription so
--           the rest of the platform plumbing (webhooks, billing_controls,
--           entitlements) still treats the tenant like a normal subscriber, but
--           Stripe never bills anything. Used for internal workspaces and
--           any other workspace that should not be charged.
-- In both cases, /insights renders non-zero customer_cost_usd at the contract rates.
CREATE TABLE enterprise_contracts (
  account_id                  UUID PRIMARY KEY REFERENCES accounts(id),
  included_ous                BIGINT        NOT NULL,
  precommit_extra_ous         BIGINT        NOT NULL DEFAULT 0,
  included_rate_usd_per_ou    NUMERIC(10,6) NOT NULL,
  precommit_rate_usd_per_ou   NUMERIC(10,6) NOT NULL,
  reload_rate_usd_per_ou      NUMERIC(10,6) NOT NULL,
  stripe_billed               BOOLEAN       NOT NULL DEFAULT TRUE,
  effective_from              TIMESTAMPTZ   NOT NULL DEFAULT NOW(),
  effective_to                TIMESTAMPTZ,
  contract_reference          TEXT,    -- URL/path/DocuSign envelope ID for the signed contract
  notes                       TEXT,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  is_annual_plan              BOOLEAN       NOT NULL DEFAULT FALSE,
  annual_total_usd_cents      BIGINT        NULL CHECK (annual_total_usd_cents IS NULL OR annual_total_usd_cents >= 0),
  CHECK (included_rate_usd_per_ou  >= 0),
  CHECK (precommit_rate_usd_per_ou >= 0),
  CHECK (reload_rate_usd_per_ou    >= 0)
);

-- ── OU-native column on billing_spend_events ──────────────────────────────────
ALTER TABLE billing_spend_events
  ADD COLUMN ou_consumed       NUMERIC(18,3) NOT NULL DEFAULT 0,
  ADD COLUMN customer_cost_usd NUMERIC(18,8) NOT NULL DEFAULT 0,
  ADD COLUMN cost_bucket       TEXT          NOT NULL DEFAULT 'unknown'
    CHECK (cost_bucket IN ('included','precommit','reload','unknown')),
  ADD CONSTRAINT billing_spend_events_ou_consumed_nonneg CHECK (ou_consumed >= 0);

-- cost_attribution_events: the canonical ledger /insights reads from after this PR.
-- Partition cascade works automatically in PG 11+; columns appear on every monthly partition.
ALTER TABLE cost_attribution_events
  ADD COLUMN ou_consumed       NUMERIC(18,3) NOT NULL DEFAULT 0,
  ADD COLUMN customer_cost_usd NUMERIC(18,8) NOT NULL DEFAULT 0,
  ADD COLUMN cost_bucket       TEXT          NOT NULL DEFAULT 'unknown'
    CHECK (cost_bucket IN ('included','precommit','reload','unknown')),
  ADD CONSTRAINT cost_attribution_events_ou_consumed_nonneg CHECK (ou_consumed >= 0);
