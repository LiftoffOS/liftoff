-- Adds telemetry columns + indexes to both outbox tables so the outbox
-- acknowledgment reconciler (Phase 2 / Fix B-2) can quickly find unverified
-- rows.
--
-- reconciler_checked_at: last time the reconciler asked the subscriber about
--   this event. Used to throttle re-checks to once per 5 min per row.
-- reconciler_subscriber_status: caching the last subscriber response (one of
--   'processed', 'failed', 'processing', 'unknown') for forensic queries:
--     SELECT * FROM internal_agent_outbox
--      WHERE reconciler_subscriber_status = 'unknown'
--        AND completed_at < NOW() - INTERVAL '1 hour';

ALTER TABLE internal_agent_outbox
  ADD COLUMN reconciler_checked_at        TIMESTAMPTZ,
  ADD COLUMN reconciler_subscriber_status TEXT;

ALTER TABLE control_plane_outbox
  ADD COLUMN reconciler_checked_at        TIMESTAMPTZ,
  ADD COLUMN reconciler_subscriber_status TEXT;

-- Partial indexes targeting the reconciler's primary query: completed rows
-- in the (-24h, -15min) window that haven't been re-checked recently.
CREATE INDEX internal_agent_outbox_reconciler_due
  ON internal_agent_outbox (completed_at)
  WHERE status = 'completed';

CREATE INDEX control_plane_outbox_reconciler_due
  ON control_plane_outbox (completed_at)
  WHERE status = 'completed';
