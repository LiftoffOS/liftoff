-- Live presence for chat threads.
--
-- Threads are tenant-wide and the Slack/Teams channels are multi-author, but
-- nothing represented who is *currently* in a thread. The sender on a stored
-- message answers "who wrote this"; this answers "who is here now".
--
-- Heartbeat table, not an event log: one row per (thread, account), rewritten
-- every few seconds by whoever is looking. Reads filter on a staleness window
-- rather than trusting a "left" signal, so a browser that dies without saying
-- goodbye decays out on its own. Same shape as the tunnel-deployment heartbeat
-- (src/tunnels/internal-router.ts), which already uses a 90s window.
--
-- fillfactor leaves room in each page so the last_seen_at rewrite stays a HOT
-- update: the primary key never changes, so no index entry is rewritten and the
-- row does not have to migrate to another page.

CREATE TABLE agent_chat_presence (
  thread_id    UUID NOT NULL,
  account_id   UUID NOT NULL REFERENCES accounts(id),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  -- 'typing' decays to 'viewing' on read after a few seconds, so a client that
  -- dies mid-compose does not appear to type forever.
  state        TEXT NOT NULL CHECK (state IN ('viewing', 'typing')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, account_id),
  -- Composite FK works because migration 291 added UNIQUE (id, tenant_id) on
  -- agent_chat_threads. Cascade keeps presence from outliving its thread.
  FOREIGN KEY (thread_id, tenant_id)
    REFERENCES agent_chat_threads (id, tenant_id) ON DELETE CASCADE
) WITH (fillfactor = 70);

-- The only read: everyone on a thread seen recently. Primary key already leads
-- with thread_id, so this covers the staleness filter on top of it.
CREATE INDEX idx_acp_thread_seen ON agent_chat_presence (thread_id, last_seen_at DESC);

ALTER TABLE agent_chat_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_chat_presence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_chat_presence
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
