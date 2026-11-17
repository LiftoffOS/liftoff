-- Idempotent settle target for the tenant-runtime chat-turn completion
-- callback: at most one ASSISTANT message per turn, so the callback and the
-- live SSE persistence path cannot double-write under their race. Migration
-- 294's idx_acm_turn stays (non-unique; it serves lookups for all roles).

CREATE UNIQUE INDEX IF NOT EXISTS acm_assistant_turn_uniq
  ON agent_chat_messages (turn_id)
  WHERE turn_id IS NOT NULL AND role = 'assistant';
