-- Forensic log of DLQ-drained messages. Insert-only from the DLQ drainer;
-- never updated except for the republish-result fields.
-- Operators query this to see what's been lost and decide whether to
-- manually republish or accept the loss.

CREATE TABLE failed_events (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                  UUID NOT NULL,
  original_event_id          UUID,                              -- null if payload didn't parse
  original_topic             TEXT NOT NULL,                     -- e.g. 'control-plane-events-<env>'
  original_subscription      TEXT NOT NULL,                     -- e.g. 'projects/.../subscriptions/control-plane-events-<env>-dlq-sub'
  dlq_message_id             TEXT NOT NULL UNIQUE,              -- Pub/Sub message ID at DLQ delivery
  payload                    JSONB,                             -- null only if message body wasn't valid UTF-8 JSON
  payload_raw_base64         TEXT NOT NULL,                     -- always the bytes; for unparseable forensics
  attributes                 JSONB,
  publish_time               TIMESTAMPTZ,
  drained_at                 TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  delivery_attempt_count     INTEGER,
  republished                BOOLEAN NOT NULL DEFAULT FALSE,
  republished_at             TIMESTAMPTZ,
  republished_message_id     TEXT,
  republish_error            TEXT,
  notes                      TEXT
);

CREATE INDEX failed_events_tenant_drained ON failed_events (tenant_id, drained_at DESC);
CREATE INDEX failed_events_topic_drained  ON failed_events (original_topic, drained_at DESC);
CREATE INDEX failed_events_event_id       ON failed_events (original_event_id) WHERE original_event_id IS NOT NULL;

-- No RLS — operator-only via withAdminScope-equivalent on the subscriber pool.
