ALTER TABLE billing_spend_events
  ADD COLUMN IF NOT EXISTS stripe_metered_at TIMESTAMPTZ NULL;

CREATE INDEX IF NOT EXISTS idx_billing_spend_events_unmetered
  ON billing_spend_events (account_id, processed_at)
  WHERE stripe_metered_at IS NULL;
