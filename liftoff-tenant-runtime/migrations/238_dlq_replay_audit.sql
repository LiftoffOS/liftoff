-- WS-4.4 — audit log for DLQ replayer one-shot.

CREATE TABLE dlq_replay_audit (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id          text NOT NULL UNIQUE,
  source_topic        text NOT NULL,
  dlq_subscription    text NOT NULL,
  replayed_at         timestamptz NOT NULL DEFAULT NOW()
);
