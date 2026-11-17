-- Migration 011: Transactional outbox
--
-- Events are inserted into outbox_events in the same DB transaction as the
-- mutation that triggered them (workforce plan status changes, etc.).
-- The outbox worker polls this table, publishes to Pub/Sub, and records the
-- event_id in processed_events to prevent duplicate delivery.
--
-- Locking strategy: the worker sets locked_until = NOW() + interval before
-- fetching a batch, so concurrent workers skip already-claimed rows.

CREATE TABLE outbox_events (
  id             UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type    TEXT        NOT NULL,
  entity_id      UUID        NOT NULL,
  event_type     TEXT        NOT NULL,
  entity_version INT         NOT NULL,
  event_version  INT         NOT NULL DEFAULT 1,
  tenant_id      UUID        NOT NULL,
  payload        JSONB       NOT NULL DEFAULT '{}',
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  locked_until   TIMESTAMPTZ,
  attempts       INT         NOT NULL DEFAULT 0
);

-- Worker polling: grab rows where locked_until IS NULL (partial index over constant predicate only).
-- The time-based expiry (locked_until < NOW()) cannot appear in a partial index predicate since
-- NOW() is STABLE not IMMUTABLE; the query layer filters on locked_until directly.
CREATE INDEX outbox_events_pending_idx
  ON outbox_events (created_at)
  WHERE locked_until IS NULL;

-- Deduplication: the worker inserts event_id here after successful publish.
-- Retained for 7 days; swept by a separate cron or on each worker cycle.
CREATE TABLE processed_events (
  event_id      UUID        PRIMARY KEY,
  processed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX processed_events_sweep_idx
  ON processed_events (processed_at);

COMMENT ON TABLE outbox_events IS
  'Transactional outbox. Inserted with mutations; published to Pub/Sub by the worker.';
COMMENT ON COLUMN outbox_events.locked_until IS
  'Optimistic lock: worker sets this before fetching to prevent concurrent processing.';
COMMENT ON TABLE processed_events IS
  'Deduplication log. Event IDs retained for 7 days to guard against double-publish.';
