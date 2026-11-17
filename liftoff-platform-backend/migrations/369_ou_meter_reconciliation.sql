-- 369: ou_meter_reconciliation — the ledger-vs-Stripe comparison that has never existed.
--
-- WHY THIS EXISTS. Our side of OU metering is recorded, but nothing compares
-- it with Stripe's side. The control that was supposed to do it, the daily
-- ou-report job, ordered by a column its table did not have and so could not
-- write a row; it was deleted in migration 367.
--
-- Without that comparison a recording gap goes unnoticed. For example, an
-- unscoped canonical-host guard that 404s every non-GET on a raw *.run.app
-- host leaves days with zero billing_spend_events rows, and nothing compares
-- what we recorded against what Stripe received. A reconciliation goes red on
-- day one.
--
-- WHAT IS COMPARED. Quantity sent versus quantity received -- NOT money. The
-- OU meter is telemetry: its price is $0.00 because every OU bucket is prepaid
-- (the base monthly fee covers included + precommit, and reload drains the
-- customer's wallet), so a dollar comparison would be meaningless. What matters
-- is transport integrity: every meter event we believe we fired should be
-- visible in Stripe's aggregate for that customer and day.
--
-- ledger_value is the sum of the values our senders actually pass, and
-- stripe_value is Stripe's aggregated_value from listEventSummaries.
--
-- EXEMPT ACCOUNTS ARE INCLUDED, AND ARE THE INTERESTING CASE. INV-PB-011 keeps
-- billing_exempt out of measurement, so the ledger side is computed
-- exemption-blind. The flag is recorded here only to state the EXPECTATION: an
-- exempt account must show consumption on our side and exactly zero on
-- Stripe's. That is an assertion, not a skip, and it is what would catch
-- an internal (exempt) account accidentally being metered.
--
-- period_day is a DATE at UTC. Stripe's meter summaries are eventually
-- consistent and want UTC-day-aligned boundaries, so the job reconciles a
-- LAGGED day (yesterday), never today.
--
-- The unique index makes re-runs idempotent: the scheduler retries on non-2xx,
-- and a retry must correct the row rather than append a second verdict.

CREATE TABLE IF NOT EXISTS ou_meter_reconciliation (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id          UUID        NOT NULL,
  period_day          DATE        NOT NULL,
  -- NUMERIC(18,6): the ledger side sums NUMERIC(18,8) customer_cost_usd and
  -- NUMERIC(12,6) cost_usd; six decimals matches what fireOuMeterEvent
  -- serializes to Stripe (costUsd.toFixed(6)), so a mismatch here is a real
  -- difference rather than a rounding artefact of our own storage.
  ledger_value        NUMERIC(18,6) NOT NULL DEFAULT 0,
  stripe_value        NUMERIC(18,6) NOT NULL DEFAULT 0,
  delta_value         NUMERIC(18,6) NOT NULL DEFAULT 0,
  billing_exempt      BOOLEAN     NOT NULL DEFAULT FALSE,
  -- 'match'          — within tolerance
  -- 'drift'          — outside tolerance; the job returns non-2xx
  -- 'exempt_metered' — an exempt account reached Stripe at all; always a defect
  -- 'stripe_error'   — the summary call failed; recorded so a silent gap in the
  --                    CHECK itself is visible rather than looking like a match
  status              TEXT        NOT NULL
                        CHECK (status IN ('match','drift','exempt_metered','stripe_error')),
  unmetered_backlog   INTEGER     NOT NULL DEFAULT 0,
  retry_queue_depth   INTEGER     NOT NULL DEFAULT 0,
  note                TEXT,
  checked_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_ou_meter_recon_account_day
  ON ou_meter_reconciliation (account_id, period_day);

-- Operators ask "what drifted recently", never "what did account X do in March".
CREATE INDEX IF NOT EXISTS idx_ou_meter_recon_status_day
  ON ou_meter_reconciliation (status, period_day DESC)
  WHERE status <> 'match';

COMMENT ON TABLE ou_meter_reconciliation IS
  'Daily per-account comparison of OU meter quantity sent (our ledger) against Stripe''s aggregated_value. Telemetry integrity, not money: the OU meter price is $0.00. Exempt accounts are asserted to be zero on Stripe''s side rather than skipped.';

COMMENT ON COLUMN ou_meter_reconciliation.billing_exempt IS
  'Recorded to set the expectation (exempt => Stripe must be zero), never to filter the measurement. INV-PB-011 keeps the flag out of the ledger-side computation.';
