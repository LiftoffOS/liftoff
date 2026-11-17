-- WS-3.4: Per-(recipient, body-hash) dedup for the notifications_send tool.
-- 24h TTL. Swept hourly via the internal-cron handler.

CREATE TABLE notification_dedup (
  id                      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id               uuid NOT NULL,
  agent_id                uuid NOT NULL,
  invocation_id           uuid,
  recipient_account_id    uuid NOT NULL,
  body_sha256             text NOT NULL,
  created_at              timestamptz NOT NULL DEFAULT NOW()
);

-- Composite uniqueness for the dedup check.
CREATE UNIQUE INDEX notification_dedup_recipient_body
  ON notification_dedup (recipient_account_id, body_sha256);

-- For TTL sweep.
CREATE INDEX notification_dedup_created_at_idx
  ON notification_dedup (created_at);
