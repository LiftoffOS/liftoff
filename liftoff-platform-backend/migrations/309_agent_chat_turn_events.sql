-- Execution events for a chat turn, so people other than the sender can watch
-- the AI team work instead of staring at a frozen thread.
--
-- Today the SSE stream IS the response to the sender's POST: it lives in one
-- request handler, on one Cloud Run instance, and nothing outside that closure
-- can observe it. With no session affinity there is no way to hand a second
-- viewer onto that same stream, and there is no shared pub/sub to bridge
-- instances. So the events are written down and read back by cursor.
--
-- Cursor, not a live pipe, buys the thing a socket cannot: replay. Someone who
-- joins halfway through a two-minute turn sees what they missed, and so does
-- anyone who reloads or drops their connection.
--
-- `seq` is assigned by the producer, not a sequence object: within a turn there
-- is exactly one producer (runAgentChatTurn), so an in-process counter is
-- gap-free and totally ordered. A Postgres sequence would leave gaps on
-- rollback, and a consumer cannot tell a gap from a lost event.

CREATE TABLE agent_chat_turn_events (
  turn_id    UUID NOT NULL,
  seq        INTEGER NOT NULL,
  tenant_id  UUID NOT NULL REFERENCES tenants(id),
  thread_id  UUID NOT NULL,
  -- 'text' carries a coalesced chunk of assistant output; the rest mirror the
  -- SSE event vocabulary the sender already receives.
  kind       TEXT NOT NULL,
  payload    JSONB,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (turn_id, seq)
);

-- The only read: "everything on this turn after seq N", already served by the
-- primary key. This index serves the other question — "is a turn live on this
-- thread right now" — which the presence poll asks every few seconds.
CREATE INDEX idx_acte_thread_recent
  ON agent_chat_turn_events (thread_id, created_at DESC);

ALTER TABLE agent_chat_turn_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_chat_turn_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_chat_turn_events
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
