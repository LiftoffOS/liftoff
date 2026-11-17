-- 015_slack_event_dedup.sql
--
-- Per-tenant idempotency table for Slack Events API webhook deliveries.
--
-- Slack retries undelivered events up to 3 times within ~3 seconds and at
-- escalating intervals after that. Each retry carries the same `event_id`.
-- The webhook handler inserts the event_id with ON CONFLICT DO NOTHING; a
-- conflict means we have already processed it and can ack 200 without
-- re-doing work.
--
-- Rows are pruned by an out-of-band cleanup (or by a periodic DELETE in
-- the polling scheduler) — retries stop after roughly 1 hour, so anything
-- older than that is dead weight.

CREATE TABLE slack_event_dedup (
  event_id TEXT PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_slack_event_dedup_received_at
  ON slack_event_dedup (received_at);

-- Grants. The webhook handler runs under withAdminScope (it must INSERT
-- and SELECT before any tenant context is known — the tenant is resolved
-- FROM the event), so connector_admin needs full DML.
GRANT SELECT, INSERT, DELETE ON TABLE slack_event_dedup TO connector_admin;
