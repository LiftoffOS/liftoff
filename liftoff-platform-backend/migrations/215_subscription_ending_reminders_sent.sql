-- Migration 215: subscription_ending_reminders_sent dedupe table
--
-- Idempotency record for the daily subscription-ending-reminders job. Composite
-- PK includes sent_date so re-cancel after a resubscribe cycle is not
-- permanently blocked.
--
-- Note: PostgreSQL PRIMARY KEY does not accept expressions like
-- `(sent_at::date)`; we materialize the date into its own column with a
-- CURRENT_DATE default. Cloud SQL runs in UTC, so CURRENT_DATE matches
-- sent_at::date for every realistic insert path. The job's INSERT statement
-- does not specify sent_date — the default kicks in.

CREATE TABLE subscription_ending_reminders_sent (
  account_id     UUID        NOT NULL,
  days_until_end INT         NOT NULL,
  sent_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  sent_date      DATE        NOT NULL DEFAULT CURRENT_DATE,
  PRIMARY KEY (account_id, days_until_end, sent_date)
);

COMMENT ON TABLE subscription_ending_reminders_sent IS
  'Idempotency record for the daily subscription-ending-reminders job. Composite PK includes sent_date so re-cancel after a resubscribe cycle is not permanently blocked.';
