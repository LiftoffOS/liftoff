-- chat_turn_locks
-- Per-thread advisory lock for chat-turn serialization.
-- Lock row lifecycle: acquired via INSERT ... ON CONFLICT DO NOTHING RETURNING,
-- renewed via UPDATE heartbeat (20-min expiry window), released via DELETE.
-- Reaper uses SELECT FOR UPDATE SKIP LOCKED + tombstone (60s TTL) to evict
-- stale workspaces atomically.

CREATE TABLE IF NOT EXISTS chat_turn_locks (
  tenant_id UUID NOT NULL,
  thread_id UUID NOT NULL,
  acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '20 minutes',
  acquired_by_invocation_id UUID NOT NULL,
  PRIMARY KEY (tenant_id, thread_id)
);

CREATE INDEX IF NOT EXISTS idx_chat_turn_locks_expires
  ON chat_turn_locks (expires_at);

CREATE INDEX IF NOT EXISTS idx_chat_turn_locks_invocation
  ON chat_turn_locks (acquired_by_invocation_id);

COMMENT ON TABLE chat_turn_locks IS
  'Per-thread chat turn advisory lock. Row = live turn; expires_at in past = stale.';
