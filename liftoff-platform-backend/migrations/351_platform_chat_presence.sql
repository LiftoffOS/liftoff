-- Migration 351: workspace-wide Liftoff and Insights chat, plus presence.
--
-- Two changes ship together because the second only makes sense after the
-- first. There is no DDL for the visibility half: it was never expressed in
-- schema, only in `src/liftoff/chat-repository.ts` and
-- `src/insights/chat-repository.ts`, which read the caller's tenant role and
-- narrowed the query to `account_id = $caller` for members and viewers. This
-- file is where the decision is recorded.
--
-- ── DELIBERATE WIDENING, READ THIS BEFORE DEPLOYING ────────────────────
--
-- Liftoff and Insights threads used to be PRIVATE to whoever started them:
-- owners and admins saw every thread in the workspace, members and viewers saw
-- only their own. Team chats (`agent_chat_threads`) have always been the
-- opposite, tenant-wide, and that is the model the product settled on.
--
-- From this migration onward both surfaces read like team chats: ANY member of
-- the workspace can open ANY Liftoff or Insights thread in it, and every one of
-- those threads appears in every member's chat history list. THIS APPLIES
-- RETROACTIVELY. Threads written while the surfaces were private become visible
-- to the whole workspace the moment the code that reads them ships. Nothing is
-- migrated, backfilled or flagged, because there is no per-thread privacy bit to
-- migrate: privacy was an artifact of the read query, so removing it from the
-- read query is the whole change. There is no way to keep an old thread private
-- short of deleting it.
--
-- Writes did NOT widen. Deleting or renaming somebody else's thread is still
-- author-or-owner/admin, the same rule as before, because widening a read is
-- reversible for anyone who cares and destroying a colleague's conversation is
-- not.
--
-- ── Presence ───────────────────────────────────────────────────────────
--
-- A workspace-wide thread that shows no sign of the other people in it invites
-- exactly the collisions team chat already solved: two people answering the
-- same question, or typing over each other. `agent_chat_presence` (migration
-- 306) answers "who is here now" for team chat; this table answers it for the
-- two platform surfaces.
--
-- ONE TABLE, NOT TWO. The alternative was a mirror of 306 per surface, which
-- buys a foreign key to each thread table and costs a second copy of the
-- repository. The foreign key is worth less here than it is there: both Liftoff
-- and Insights threads SOFT-delete (`deleted_at`), so an ON DELETE CASCADE would
-- never fire. What is left is two identical tables and two
-- identical repositories, so `surface` carries the distinction instead and one
-- repository serves both. It is also why `agent_chat_presence` is not simply
-- reused: its composite FK to `agent_chat_threads (id, tenant_id)` is a real
-- guarantee for that surface, and dropping it to make room for two more would
-- weaken something that works to save a table that costs nothing.
--
-- Heartbeat table, not an event log, exactly as 306: one row per
-- (surface, thread, account), rewritten every few seconds by whoever is looking,
-- read through a staleness window rather than a "left" signal, so a browser that
-- dies without saying goodbye decays out on its own.
--
-- fillfactor leaves room in each page so the last_seen_at rewrite stays a HOT
-- update: the primary key never changes, so no index entry is rewritten and the
-- row does not have to migrate to another page.

CREATE TABLE platform_chat_presence (
  -- Which platform chat this row belongs to. Thread ids are UUIDs and do not
  -- collide across the two tables in practice, but the discriminator keeps the
  -- two namespaces honest and keeps the read index tight.
  surface      TEXT NOT NULL CHECK (surface IN ('liftoff', 'insights')),
  thread_id    UUID NOT NULL,
  account_id   UUID NOT NULL REFERENCES accounts(id),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  -- 'typing' decays to 'viewing' on read after a few seconds, so a client that
  -- dies mid-compose does not appear to type forever.
  state        TEXT NOT NULL CHECK (state IN ('viewing', 'typing')),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (surface, thread_id, account_id)
  -- No foreign key to a thread table: there are two of them, and both soft-delete,
  -- so the cascade a single-surface table would give us could never fire. Rows for
  -- a thread nobody visits are swept opportunistically by the repository.
) WITH (fillfactor = 70);

-- The only read: everyone on one thread of one surface, seen recently. The
-- primary key already leads with (surface, thread_id), so this covers the
-- staleness filter on top of it.
CREATE INDEX idx_pcp_surface_thread_seen
  ON platform_chat_presence (surface, thread_id, last_seen_at DESC);

-- ── Row-level security ─────────────────────────────────────────────────
--
-- Written out rather than inherited, for the same reason migration 348 spells
-- it out: the DO-loops that enable RLS on every tenant_id table (migrations
-- 095, 287, 289) have already run and will never see a table created after
-- them, so a new tenant-scoped table gets nothing unless it says so here.

ALTER TABLE platform_chat_presence ENABLE ROW LEVEL SECURITY;
ALTER TABLE platform_chat_presence FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON platform_chat_presence
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
