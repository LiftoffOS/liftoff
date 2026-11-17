-- Migration 433: unread state for Liftoff chat threads
--
-- The agent-chat unread design (migration 338, ADR-046), applied to the
-- Liftoff assistant's own stack. The product question is identical — does this
-- thread have a reply I have not seen, does this surface have one — and the
-- frontend draws the same dot for it (the home page's Resume button, the
-- history modal's rows), so the mechanism is deliberately the same: a reply
-- clock denormalised onto the thread, and a durable per-account read marker.
--
-- Liftoff threads live in their own table (migration 348, "independent
-- stacks"), so nothing from 338 reaches them: agent_chat_thread_reads is
-- foreign-keyed to agent_chat_threads and the unread-counts query never leaves
-- it. This is the liftoff_chat_threads copy of the same two pieces of schema.
--
-- Full reasoning: migration 338 (agent chat unread state). Everything argued
-- there holds unchanged here; the notes below only record what differs.

-- ── The assistant-reply clock on the thread ────────────────────────────────
--
-- Deliberately NOT updated_at: that moves when the *person* sends a message
-- too, which would make every thread the person just wrote in unread. NULL
-- means Liftoff has never replied in this thread, which is never unread.
ALTER TABLE liftoff_chat_threads ADD COLUMN last_assistant_message_at TIMESTAMPTZ;

-- ── The address the read marker's FK needs ─────────────────────────────────
--
-- 338 leaned on UNIQUE (id, tenant_id), which migration 291 had already given
-- agent_chat_threads for presence's sake. liftoff_chat_threads never needed it
-- before, so it is added here: the composite FK below is what makes a marker
-- for another tenant's thread unwritable at the schema layer, on top of RLS.
ALTER TABLE liftoff_chat_threads ADD CONSTRAINT liftoff_chat_threads_id_tenant_key UNIQUE (id, tenant_id);

-- ── The read marker, per account ───────────────────────────────────────────
--
-- Per account, not per tenant: two people in one workspace have genuinely
-- different unread state, and since migration 351 every member can open every
-- thread on this surface.
--
-- Cascade keeps a marker from outliving its thread. Threads on this surface
-- are soft-deleted in practice, so the cascade is belt-and-braces; the read
-- paths filter deleted_at themselves.
--
-- fillfactor for the same reason 338 uses it: these rows are updated far more
-- often than inserted, and leaving room in the page keeps the last_read_at
-- rewrite a HOT update.
CREATE TABLE liftoff_chat_thread_reads (
  thread_id    UUID NOT NULL,
  account_id   UUID NOT NULL REFERENCES accounts(id),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, account_id),
  FOREIGN KEY (thread_id, tenant_id)
    REFERENCES liftoff_chat_threads (id, tenant_id) ON DELETE CASCADE
) WITH (fillfactor = 70);

-- RLS: ENABLE + FORCE + tenant policy (INV-PB-001).
ALTER TABLE liftoff_chat_thread_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE liftoff_chat_thread_reads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON liftoff_chat_thread_reads
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ── Index for the count query ──────────────────────────────────────────────
--
-- Migration 348's partial indexes serve the two list paths on (tenant_id,
-- updated_at) and do not cover a predicate on the reply clock. The read
-- marker side needs nothing new: the primary key on (thread_id, account_id)
-- already covers the join.
CREATE INDEX idx_lct_tenant_unread ON liftoff_chat_threads (tenant_id, last_assistant_message_at DESC)
  WHERE deleted_at IS NULL AND last_assistant_message_at IS NOT NULL;

-- ── No backfill, deliberately ──────────────────────────────────────────────
--
-- Same argument as 338, which tried the backfill and reverted it: the clock
-- stays NULL on every existing thread, so nothing that predates this carries a
-- dot, and the first indicator anyone sees is a reply that genuinely arrived
-- after it shipped. Seeding markers would assert what each person had read
-- before read state existed, which is not knowable.
--
-- What remains is pure DDL: nothing here reads or writes a row, so no
-- NO FORCE / FORCE ROW LEVEL SECURITY escape is needed. The UNIQUE constraint
-- builds its index without evaluating row security (see migration 296).
