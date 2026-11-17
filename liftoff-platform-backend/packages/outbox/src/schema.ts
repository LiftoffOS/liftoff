// Outbox table DDL — provisioned in every service's own database. The
// publisher polls for `published_at IS NULL` rows; consumers dedup via
// `processed_events.event_id` UNIQUE.

export const OUTBOX_EVENTS_DDL = `
CREATE TABLE IF NOT EXISTS outbox_events (
  id              BIGSERIAL PRIMARY KEY,
  event_id        UUID NOT NULL UNIQUE,
  event_type      TEXT NOT NULL,
  schema_version  INTEGER NOT NULL,
  tenant_id       UUID NOT NULL,
  occurred_at     TIMESTAMPTZ NOT NULL,
  source_service  TEXT NOT NULL,
  trace_id        TEXT,
  payload         JSONB NOT NULL,
  published_at    TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_outbox_unpublished
  ON outbox_events (published_at)
  WHERE published_at IS NULL;
`;

export function createProcessedEventsTableSql(): string {
  return `
CREATE TABLE IF NOT EXISTS processed_events (
  event_id        UUID PRIMARY KEY,
  event_type      TEXT NOT NULL,
  processed_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
`;
}
