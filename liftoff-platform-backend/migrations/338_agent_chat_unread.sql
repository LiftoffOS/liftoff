-- Migration 338: unread state for agent chat threads
--
-- Three indicators in the product ask the same question at three
-- granularities: does this thread have a reply I have not seen, does this team
-- have one, does this team seen from the teams list have one. They are one
-- query and one piece of state, not three mechanisms.
--
-- Nothing recorded read state anywhere before this. `agent_chat_presence`
-- (migration 306) has the exact key shape and is still the wrong home: its rows
-- are DELETEd on leave and it is a viewing/typing heartbeat, so durable read
-- state cannot live there. It is the right pattern to copy, though — same key,
-- same composite FK, same FORCE RLS pair — and that is what this table does.
--
-- "Has an unread reply" means the newest assistant message is newer than this
-- account's read marker. Asking that per thread would mean a MAX(created_at)
-- subquery against agent_chat_messages on every list render and again on every
-- counts poll. So the assistant timestamp is denormalised onto the thread: the
-- write already happens (appendMessage touches the thread on every message),
-- and both reads become a single join that never touches the message table.
--
-- (agent_chat_messages is a single unpartitioned table, despite what migration
-- 105's section header says — partitioning was deferred there and never landed.
-- The denormalisation is worth it either way: it removes a per-row correlated
-- subquery from two hot reads.)
--
-- Full reasoning: ADR-046 (agent chat unread state).

-- ── The assistant-reply clock on the thread ────────────────────────────────
--
-- Deliberately NOT updated_at: that moves when the *user* sends a message too,
-- which would make every thread the user just wrote in unread. NULL means the
-- team has never replied in this thread, which is never unread.
ALTER TABLE agent_chat_threads ADD COLUMN last_agent_message_at TIMESTAMPTZ;

-- ── The read marker, per account ───────────────────────────────────────────
--
-- Per account, not per tenant: two people in one workspace have genuinely
-- different unread state.
--
-- The composite FK works for the same reason presence's does — migration 291
-- added UNIQUE (id, tenant_id) on agent_chat_threads. Cascade keeps a read
-- marker from outliving its thread.
--
-- fillfactor for the same reason presence uses it: these rows are updated far
-- more often than inserted, and leaving room in the page keeps the
-- last_read_at rewrite a HOT update — the primary key never changes, so no
-- index entry is rewritten and the row does not migrate to another page.
CREATE TABLE agent_chat_thread_reads (
  thread_id    UUID NOT NULL,
  account_id   UUID NOT NULL REFERENCES accounts(id),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, account_id),
  FOREIGN KEY (thread_id, tenant_id)
    REFERENCES agent_chat_threads (id, tenant_id) ON DELETE CASCADE
) WITH (fillfactor = 70);

-- RLS: ENABLE + FORCE + tenant policy (INV-PB-001).
ALTER TABLE agent_chat_thread_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_chat_thread_reads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_chat_thread_reads
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ── Index for the counts query ─────────────────────────────────────────────
--
-- The existing idx_act_tenant is (tenant_id, updated_at DESC) and does not
-- serve a predicate on last_agent_message_at. The read side needs nothing new:
-- the primary key on (thread_id, account_id) already covers it.
CREATE INDEX idx_act_tenant_unread ON agent_chat_threads (tenant_id, last_agent_message_at DESC)
  WHERE deleted_at IS NULL AND last_agent_message_at IS NOT NULL;

-- ── No backfill, deliberately ──────────────────────────────────────────────
--
-- last_agent_message_at stays NULL on every thread that already exists, which
-- by the predicate above means "never unread". The feature therefore starts
-- live: nothing that predates it carries a dot, and the first indicator anyone
-- sees is a reply that genuinely arrived after this shipped.
--
-- The obvious alternative — stamp the clock from the newest assistant message,
-- then seed the thread owner's marker at NOW() — is wrong twice:
--
--   1. It assumes every thread HAS an owner. agent_chat_threads.account_id has
--      been nullable since migration 111 (Slack guest threads), so the seeding
--      INSERT dies on a NOT NULL violation against real data.
--   2. Even with that fixed, it seeds ONE account per thread while threads are
--      visible to the whole tenant. Every OTHER member would open the app to a
--      dot on every conversation with a reply in it — the exact wall of dots
--      the seeding was there to prevent, just aimed at everybody except the
--      thread's author.
--
-- Seeding a marker per (thread, tenant member) would fix the second point and
-- is a cross join nobody asked for, to assert something we cannot know: what
-- each person had read before read state existed. Leaving the clock NULL says
-- the honest thing instead, and costs one deploy-window's worth of replies —
-- a thread answered minutes before this migration will not show a dot, and
-- will the next time the team speaks.
--
-- A consequence worth stating: what remains is pure DDL. Nothing here reads or
-- writes a row, so unlike migrations 327/335/336/337 this needs no
-- NO FORCE / FORCE ROW LEVEL SECURITY escape. CREATE INDEX does not evaluate
-- row security (see migration 296), and ADD COLUMN with no default is
-- metadata-only.
