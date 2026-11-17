-- migrations/001_initial_schema.sql
-- Billing database schema.
--
-- Monetary amounts are int64 cents (stored as BIGINT); no float/double.
-- Tax rates are basis points (INTEGER, 10_000 = 100 %).

BEGIN;

-- ── plans + plan_features ─────────────────────────────────────────────
CREATE TABLE plans (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  description       TEXT NOT NULL DEFAULT '',
  base_amount_cents BIGINT NOT NULL,
  currency          TEXT NOT NULL DEFAULT 'USD',
  stripe_product_id TEXT NOT NULL UNIQUE,
  stripe_price_id   TEXT NOT NULL UNIQUE,
  active            BOOLEAN NOT NULL DEFAULT TRUE,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE plan_features (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  plan_id                  UUID NOT NULL REFERENCES plans(id) ON DELETE CASCADE,
  feature_key              TEXT NOT NULL,
  included_quantity        BIGINT,
  overage_unit_cost_cents  BIGINT,
  UNIQUE(plan_id, feature_key)
);

-- ── subscriptions + items ─────────────────────────────────────────────
CREATE TYPE subscription_status AS ENUM (
  'trialing','active','past_due','canceled','unpaid','incomplete'
);

CREATE TABLE subscriptions (
  id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               UUID NOT NULL,
  stripe_subscription_id  TEXT NOT NULL UNIQUE,
  status                  subscription_status NOT NULL,
  plan_id                 UUID NOT NULL REFERENCES plans(id),
  current_period_start    TIMESTAMPTZ NOT NULL,
  current_period_end      TIMESTAMPTZ NOT NULL,
  cancel_at_period_end    BOOLEAN NOT NULL DEFAULT FALSE,
  canceled_at             TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_subscriptions_tenant ON subscriptions(tenant_id);

CREATE TABLE subscription_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  subscription_id   UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
  stripe_item_id    TEXT NOT NULL UNIQUE,
  plan_feature_id   UUID NOT NULL REFERENCES plan_features(id),
  quantity          BIGINT NOT NULL
);

-- ── invoices + line items ─────────────────────────────────────────────
CREATE TYPE invoice_status AS ENUM (
  'draft','open','paid','void','uncollectible'
);

CREATE TABLE invoices (
  id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id            UUID NOT NULL,
  stripe_invoice_id    TEXT NOT NULL UNIQUE,
  status               invoice_status NOT NULL,
  amount_due_cents     BIGINT NOT NULL,
  amount_paid_cents    BIGINT NOT NULL DEFAULT 0,
  tax_cents            BIGINT NOT NULL DEFAULT 0,
  currency             TEXT NOT NULL,
  period_start         TIMESTAMPTZ NOT NULL,
  period_end           TIMESTAMPTZ NOT NULL,
  issued_at            TIMESTAMPTZ NOT NULL,
  paid_at              TIMESTAMPTZ,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_invoices_tenant ON invoices(tenant_id);
CREATE INDEX idx_invoices_issued_at ON invoices(issued_at DESC);

CREATE TABLE invoice_line_items (
  id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  invoice_id        UUID NOT NULL REFERENCES invoices(id) ON DELETE CASCADE,
  description       TEXT NOT NULL,
  amount_cents      BIGINT NOT NULL,
  tax_rate_bps      INTEGER NOT NULL DEFAULT 0,
  quantity          BIGINT NOT NULL DEFAULT 1,
  meter_event_group TEXT
);
CREATE INDEX idx_invoice_line_items_invoice ON invoice_line_items(invoice_id);

-- ── meter events + reconciliation log ─────────────────────────────────
CREATE TABLE meter_events (
  id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id    UUID NOT NULL,
  user_id      UUID,
  vendor       TEXT NOT NULL,   -- 'anthropic' | 'openai' | 'internal'
  request_id   TEXT NOT NULL,
  quantity     BIGINT NOT NULL,
  event_type   TEXT NOT NULL,
  occurred_at  TIMESTAMPTZ NOT NULL,
  reported_at  TIMESTAMPTZ,
  cost_micros  BIGINT,
  UNIQUE (tenant_id, user_id, vendor, request_id)
);
CREATE INDEX idx_meter_events_tenant_occurred ON meter_events(tenant_id, occurred_at DESC);
CREATE INDEX idx_meter_events_unreported
  ON meter_events(occurred_at)
  WHERE reported_at IS NULL;

CREATE TABLE meter_reconciliation_log (
  id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  window_start     TIMESTAMPTZ NOT NULL,
  window_end       TIMESTAMPTZ NOT NULL,
  tenant_id        UUID,
  events_scanned   BIGINT NOT NULL,
  events_reported  BIGINT NOT NULL,
  drift_count      BIGINT NOT NULL,
  net_drift_micros BIGINT NOT NULL,
  completed_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_reconciliation_log_completed ON meter_reconciliation_log(completed_at DESC);

-- ── payment methods ──────────────────────────────────────────────────
CREATE TABLE payment_methods (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  UUID NOT NULL,
  stripe_payment_method_id   TEXT NOT NULL UNIQUE,
  brand                      TEXT NOT NULL,
  last4                      TEXT NOT NULL,
  exp_month                  SMALLINT NOT NULL,
  exp_year                   SMALLINT NOT NULL,
  is_default                 BOOLEAN NOT NULL DEFAULT FALSE,
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX idx_payment_methods_tenant ON payment_methods(tenant_id);

CREATE TABLE payment_method_audit (
  id                 BIGSERIAL PRIMARY KEY,
  payment_method_id  UUID NOT NULL,
  tenant_id          UUID NOT NULL,
  actor_user_id      TEXT,
  action             TEXT NOT NULL,  -- 'added' | 'removed' | 'set_default'
  occurred_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── Stripe webhook events ─────────────────────────────────────────────
CREATE TABLE stripe_webhook_events (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  stripe_event_id       TEXT NOT NULL UNIQUE,
  stripe_event_type     TEXT NOT NULL,
  livemode              BOOLEAN NOT NULL,
  api_version           TEXT,
  payload_sha256        TEXT NOT NULL,
  payload               JSONB NOT NULL,
  signature             TEXT NOT NULL,
  signature_timestamp_ms BIGINT NOT NULL,
  received_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  processed_at          TIMESTAMPTZ,
  processing_errors     TEXT[]
);
CREATE INDEX idx_stripe_webhook_unprocessed
  ON stripe_webhook_events(received_at)
  WHERE processed_at IS NULL;

-- ── credit balance ───────────────────────────────────────────────────
CREATE TABLE credit_balances (
  tenant_id         UUID PRIMARY KEY,
  available_cents   BIGINT NOT NULL DEFAULT 0,
  reserved_cents    BIGINT NOT NULL DEFAULT 0,
  as_of             TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── outbox + processed_events (from @liftoffos/outbox schema) ─────────
CREATE TABLE outbox_events (
  id              BIGSERIAL PRIMARY KEY,
  event_id        UUID NOT NULL UNIQUE,
  event_type      TEXT NOT NULL,
  schema_version  INTEGER NOT NULL,
  tenant_id       UUID NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL,
  source_service  TEXT NOT NULL DEFAULT 'liftoff-billing',
  trace_id        TEXT,
  payload         JSONB NOT NULL,
  published_at    TIMESTAMPTZ
);
CREATE INDEX idx_outbox_unpublished
  ON outbox_events (published_at)
  WHERE published_at IS NULL;

CREATE TABLE processed_events (
  event_id      UUID PRIMARY KEY,
  event_type    TEXT NOT NULL,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ── audit log (append-only, monthly partitions, 7-year retention) ─────
-- Parent table; first partitions in migration 003.
CREATE TABLE billing_audit_log (
  id             BIGSERIAL,
  tenant_id      UUID NOT NULL,
  actor_user_id  TEXT,
  action         TEXT NOT NULL,
  target_ref     TEXT,
  payload_json   JSONB,
  prev_hash      TEXT NOT NULL DEFAULT '',
  row_hash       TEXT NOT NULL,
  occurred_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

-- Immutability trigger: rejects UPDATE/DELETE by the app role; a hash-chain
-- column provides tamper evidence.
CREATE OR REPLACE FUNCTION billing_audit_log_immutable()
RETURNS trigger AS $$
BEGIN
  IF current_user = 'billing_app' THEN
    RAISE EXCEPTION 'billing_audit_log is append-only for billing_app (action=%, tenant=%)', TG_OP, OLD.tenant_id;
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER billing_audit_log_immutable
  BEFORE UPDATE OR DELETE ON billing_audit_log
  FOR EACH ROW
  EXECUTE FUNCTION billing_audit_log_immutable();

COMMIT;
