-- Migration 019: card_expiring_reminders_sent dedupe table
--
-- Idempotency record for the daily card-expiring-reminders job. PK includes
-- (tenant_id, exp_year, exp_month) so each card fires the 30-day reminder
-- exactly once per expiry. If the card is re-issued with a new expiry, the
-- tuple changes and the next expiry fires fresh.

CREATE TABLE card_expiring_reminders_sent (
  tenant_id  UUID     NOT NULL,
  exp_year   SMALLINT NOT NULL,
  exp_month  SMALLINT NOT NULL,
  sent_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (tenant_id, exp_year, exp_month)
);

COMMENT ON TABLE card_expiring_reminders_sent IS
  'Idempotency record for the daily card-expiring-reminders scheduled job. PK = (tenant_id, exp_year, exp_month) so each card-expiry fires the reminder exactly once.';
