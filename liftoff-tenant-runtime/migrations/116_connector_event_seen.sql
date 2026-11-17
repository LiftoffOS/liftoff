-- Dedup table for connector.record.synced events.
-- Prevents duplicate agent executions when the same eventId is delivered more
-- than once (e.g. Pub/Sub redelivery or polling cursor failure).
-- Dedup key is (tenant_id, event_id) — mirrors the pattern in event_processing_ledger.

CREATE TABLE connector_event_seen (
  tenant_id  UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  event_id   VARCHAR(255) NOT NULL,
  seen_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),

  PRIMARY KEY (tenant_id, event_id)
);

-- Supports TTL cleanup: DELETE FROM connector_event_seen WHERE seen_at < NOW() - INTERVAL '7 days'
CREATE INDEX idx_ces_seen_at ON connector_event_seen(seen_at);
