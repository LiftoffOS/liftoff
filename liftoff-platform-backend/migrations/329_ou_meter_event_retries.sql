-- 329: durable retry queue for failed Stripe OU meter events.
--
-- The cost-attribution ingest path fires the operating_unit_consumed meter
-- post-commit with no recovery mechanism: any Stripe-side rejection
-- (12-decimal values, >100-char identifiers, rate limits) permanently lost
-- billable usage. fireOuMeterEventDurable writes failures here; the hourly
-- ou-meter-retry-drain job re-fires them (Stripe's per-identifier
-- idempotency makes re-fires safe) and deletes rows on success. Rows are
-- never dropped on failure — exhausted retries stay visible and alertable.
--
-- Account-level billing infrastructure keyed by Stripe identifiers, like
-- billing_controls: no tenant_id column, no RLS.

CREATE TABLE ou_meter_event_retries (
  identifier         TEXT PRIMARY KEY,
  stripe_customer_id TEXT NOT NULL,
  cost_usd           NUMERIC(18, 6) NOT NULL,
  occurred_at        TIMESTAMPTZ NOT NULL,
  attempts           INTEGER NOT NULL DEFAULT 1,
  last_error         TEXT,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_ou_meter_event_retries_created
  ON ou_meter_event_retries (created_at);
