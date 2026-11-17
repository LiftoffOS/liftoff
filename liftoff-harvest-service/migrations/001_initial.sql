-- Up Migration

-- harvest_dedup: idempotency table for Pub/Sub at-least-once delivery
CREATE TABLE IF NOT EXISTS harvest_dedup (
  message_id TEXT PRIMARY KEY,
  processed_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_hd_processed ON harvest_dedup(processed_at);

-- harvest_cost_events: workspace-level cost reporting (NOT fed into cost_attribution_events)
-- connector_id is TEXT (not UUID column type): the value is the UUID primary key of the
-- connectors table row in connector-service, stored as text for flexibility. Nullable
-- to tolerate messages published before the event-publisher connectorId fix.
CREATE TABLE IF NOT EXISTS harvest_cost_events (
  id               UUID NOT NULL DEFAULT gen_random_uuid(),
  tenant_id        UUID NOT NULL,
  connector_id     TEXT,  -- nullable; UUID of connectors table row (stored as text)
  connector_type   TEXT NOT NULL,
  entity_type      TEXT NOT NULL,
  model            TEXT NOT NULL,
  input_tokens     INTEGER NOT NULL,
  output_tokens    INTEGER NOT NULL,
  cost_usd         NUMERIC(12, 8) NOT NULL,
  memory_type      TEXT,
  worthy           BOOLEAN NOT NULL DEFAULT false,
  source_record_id TEXT,
  message_id       TEXT,  -- Pub/Sub message id; used for idempotent inserts
  occurred_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (id, occurred_at)
) PARTITION BY RANGE (occurred_at);

CREATE INDEX IF NOT EXISTS idx_hce_tenant_occurred ON harvest_cost_events(tenant_id, occurred_at);
CREATE INDEX IF NOT EXISTS idx_hce_connector_occurred ON harvest_cost_events(connector_id, occurred_at);

-- Monthly partitions for 2025 and 2026. Future months are managed by
-- `npm run partitions` (src/jobs/manage-partitions.ts), scheduled via
-- Cloud Scheduler / pg_cron on the first of each month.
CREATE TABLE IF NOT EXISTS harvest_cost_events_y2025m01
  PARTITION OF harvest_cost_events
  FOR VALUES FROM ('2025-01-01') TO ('2025-02-01');
CREATE TABLE IF NOT EXISTS harvest_cost_events_y2025m02
  PARTITION OF harvest_cost_events
  FOR VALUES FROM ('2025-02-01') TO ('2025-03-01');
CREATE TABLE IF NOT EXISTS harvest_cost_events_y2025m03
  PARTITION OF harvest_cost_events
  FOR VALUES FROM ('2025-03-01') TO ('2025-04-01');
CREATE TABLE IF NOT EXISTS harvest_cost_events_y2025m04
  PARTITION OF harvest_cost_events
  FOR VALUES FROM ('2025-04-01') TO ('2025-05-01');
CREATE TABLE IF NOT EXISTS harvest_cost_events_y2025m05
  PARTITION OF harvest_cost_events
  FOR VALUES FROM ('2025-05-01') TO ('2025-06-01');
CREATE TABLE IF NOT EXISTS harvest_cost_events_y2025m06
  PARTITION OF harvest_cost_events
  FOR VALUES FROM ('2025-06-01') TO ('2025-07-01');
CREATE TABLE IF NOT EXISTS harvest_cost_events_y2025m07
  PARTITION OF harvest_cost_events
  FOR VALUES FROM ('2025-07-01') TO ('2025-08-01');
CREATE TABLE IF NOT EXISTS harvest_cost_events_y2025m08
  PARTITION OF harvest_cost_events
  FOR VALUES FROM ('2025-08-01') TO ('2025-09-01');
CREATE TABLE IF NOT EXISTS harvest_cost_events_y2025m09
  PARTITION OF harvest_cost_events
  FOR VALUES FROM ('2025-09-01') TO ('2025-10-01');
CREATE TABLE IF NOT EXISTS harvest_cost_events_y2025m10
  PARTITION OF harvest_cost_events
  FOR VALUES FROM ('2025-10-01') TO ('2025-11-01');
CREATE TABLE IF NOT EXISTS harvest_cost_events_y2025m11
  PARTITION OF harvest_cost_events
  FOR VALUES FROM ('2025-11-01') TO ('2025-12-01');
CREATE TABLE IF NOT EXISTS harvest_cost_events_y2025m12
  PARTITION OF harvest_cost_events
  FOR VALUES FROM ('2025-12-01') TO ('2026-01-01');

CREATE TABLE IF NOT EXISTS harvest_cost_events_y2026m01
  PARTITION OF harvest_cost_events
  FOR VALUES FROM ('2026-01-01') TO ('2026-02-01');
CREATE TABLE IF NOT EXISTS harvest_cost_events_y2026m02
  PARTITION OF harvest_cost_events
  FOR VALUES FROM ('2026-02-01') TO ('2026-03-01');
CREATE TABLE IF NOT EXISTS harvest_cost_events_y2026m03
  PARTITION OF harvest_cost_events
  FOR VALUES FROM ('2026-03-01') TO ('2026-04-01');
CREATE TABLE IF NOT EXISTS harvest_cost_events_y2026m04
  PARTITION OF harvest_cost_events
  FOR VALUES FROM ('2026-04-01') TO ('2026-05-01');
CREATE TABLE IF NOT EXISTS harvest_cost_events_y2026m05
  PARTITION OF harvest_cost_events
  FOR VALUES FROM ('2026-05-01') TO ('2026-06-01');
CREATE TABLE IF NOT EXISTS harvest_cost_events_y2026m06
  PARTITION OF harvest_cost_events
  FOR VALUES FROM ('2026-06-01') TO ('2026-07-01');
CREATE TABLE IF NOT EXISTS harvest_cost_events_y2026m07
  PARTITION OF harvest_cost_events
  FOR VALUES FROM ('2026-07-01') TO ('2026-08-01');
CREATE TABLE IF NOT EXISTS harvest_cost_events_y2026m08
  PARTITION OF harvest_cost_events
  FOR VALUES FROM ('2026-08-01') TO ('2026-09-01');
CREATE TABLE IF NOT EXISTS harvest_cost_events_y2026m09
  PARTITION OF harvest_cost_events
  FOR VALUES FROM ('2026-09-01') TO ('2026-10-01');
CREATE TABLE IF NOT EXISTS harvest_cost_events_y2026m10
  PARTITION OF harvest_cost_events
  FOR VALUES FROM ('2026-10-01') TO ('2026-11-01');
CREATE TABLE IF NOT EXISTS harvest_cost_events_y2026m11
  PARTITION OF harvest_cost_events
  FOR VALUES FROM ('2026-11-01') TO ('2026-12-01');
CREATE TABLE IF NOT EXISTS harvest_cost_events_y2026m12
  PARTITION OF harvest_cost_events
  FOR VALUES FROM ('2026-12-01') TO ('2027-01-01');

-- DEFAULT partition: catches any rows whose occurred_at falls outside the
-- explicitly provisioned range. The partition manager (`npm run partitions`)
-- moves rows out of here as it provisions new monthly partitions.
CREATE TABLE IF NOT EXISTS harvest_cost_events_default
  PARTITION OF harvest_cost_events DEFAULT;

-- DB-001: unique index on (message_id, occurred_at) for defense-in-depth idempotency.
-- Partition key (occurred_at) must be included in unique indexes on partitioned tables.
-- Primary idempotency is enforced by harvest_dedup (upfront-claim INSERT in runner.ts).
CREATE UNIQUE INDEX IF NOT EXISTS idx_hce_message_occurred
  ON harvest_cost_events(message_id, occurred_at)
  WHERE message_id IS NOT NULL;

-- pg_cron: garbage-collect harvest_dedup entries older than 7 days. Pub/Sub
-- ack-deadline + retry window is much shorter than 7d, so anything older
-- cannot be redelivered. Wrapped in a DO block so the migration succeeds
-- on instances without pg_cron installed (Cloud SQL without the extension).
-- `undefined_function` catches a missing cron.schedule; OTHERS catches the
-- schema-not-found case (pg_cron schema doesn't exist — no valid condition
-- name for that in PL/pgSQL, so OTHERS is the correct catch-all).
DO $$
BEGIN
  PERFORM cron.schedule(
    'harvest_dedup_gc',
    '17 3 * * *',
    $cron$DELETE FROM harvest_dedup WHERE processed_at < now() - INTERVAL '7 days'$cron$
  );
EXCEPTION
  WHEN OTHERS THEN
    RAISE NOTICE 'pg_cron not available (skipped); harvest_dedup GC must run via Cloud Scheduler. Error: %', SQLERRM;
END
$$;

-- Down Migration

DO $$
BEGIN
  PERFORM cron.unschedule('harvest_dedup_gc');
EXCEPTION
  WHEN OTHERS THEN
    NULL;
END
$$;

DROP TABLE IF EXISTS harvest_cost_events CASCADE;
DROP TABLE IF EXISTS harvest_dedup CASCADE;
