ALTER TABLE billing_spend_events
  ADD COLUMN IF NOT EXISTS agent_id    UUID          NULL,
  ADD COLUMN IF NOT EXISTS occurred_at TIMESTAMPTZ   NULL;

-- Index used by operating-unit-service.ts getOperatingUnitsForPeriod query:
-- filters on tenant_id + occurred_at, groups by agent_id.
CREATE INDEX IF NOT EXISTS idx_billing_spend_events_tenant_occurred
  ON billing_spend_events (tenant_id, occurred_at)
  WHERE occurred_at IS NOT NULL;
