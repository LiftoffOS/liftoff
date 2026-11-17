-- Migration 434: unread state for Insights chat threads
--
-- The third copy of the agent-chat unread design (migration 338, ADR-046;
-- Liftoff's is migration 433): a reply clock denormalised onto the thread and
-- a durable per-account read marker. The frontend draws the same dot for it,
-- on the sidebar's Insights icon and the history modal's rows.
--
-- Insights threads are their own stack (migration 074, "independent stacks"),
-- so nothing from 338 or 433 reaches them. Everything argued in the ADR holds
-- unchanged; the notes below record only what differs.

-- ── The assistant-reply clock on the thread ────────────────────────────────
--
-- Deliberately NOT updated_at: that moves when the *person* sends a message
-- too, which would make every thread the person just wrote in unread. NULL
-- means the Insights Manager has never replied in this thread, which is never
-- unread.
--
-- One nuance this surface has that Liftoff's migration did not: two writers
-- put role='assistant' rows here that are not replies (the forwarded-context
-- report a delegation writes, and media rows). The repository stamps the
-- clock only for ordinary speech (no message_type), so a delegated thread is
-- not born wearing a dot.
ALTER TABLE insights_chat_threads ADD COLUMN last_assistant_message_at TIMESTAMPTZ;

-- ── The address the read marker's FK needs ─────────────────────────────────
--
-- Same as 433: the composite FK below needs UNIQUE (id, tenant_id), which
-- this table never had (338 leaned on migration 291's for agent chat).
ALTER TABLE insights_chat_threads ADD CONSTRAINT insights_chat_threads_id_tenant_key UNIQUE (id, tenant_id);

-- ── The read marker, per account ───────────────────────────────────────────
--
-- Per account, not per tenant: two people in one workspace have genuinely
-- different unread state, and since migration 351 every member can open every
-- thread on this surface.
--
-- fillfactor for the same reason 338 uses it: these rows are updated far more
-- often than inserted, and leaving room in the page keeps the last_read_at
-- rewrite a HOT update.
CREATE TABLE insights_chat_thread_reads (
  thread_id    UUID NOT NULL,
  account_id   UUID NOT NULL REFERENCES accounts(id),
  tenant_id    UUID NOT NULL REFERENCES tenants(id),
  last_read_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (thread_id, account_id),
  FOREIGN KEY (thread_id, tenant_id)
    REFERENCES insights_chat_threads (id, tenant_id) ON DELETE CASCADE
) WITH (fillfactor = 70);

-- RLS: ENABLE + FORCE + tenant policy (INV-PB-001), spelled out because the
-- DO-loops that blanket-enabled RLS (migrations 095/287/289) ran long ago and
-- never see a table created after them (see migration 351's note).
ALTER TABLE insights_chat_thread_reads ENABLE ROW LEVEL SECURITY;
ALTER TABLE insights_chat_thread_reads FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON insights_chat_thread_reads
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

-- ── Index for the count query ──────────────────────────────────────────────
--
-- Migration 074's partial indexes serve the list paths on (tenant_id,
-- updated_at) and do not cover a predicate on the reply clock. The read
-- marker side needs nothing new: the primary key on (thread_id, account_id)
-- already covers the join.
CREATE INDEX idx_ict_tenant_unread ON insights_chat_threads (tenant_id, last_assistant_message_at DESC)
  WHERE deleted_at IS NULL AND last_assistant_message_at IS NOT NULL;

-- ── No backfill, deliberately ──────────────────────────────────────────────
--
-- Same argument as 338, which tried the backfill and reverted it: the clock
-- stays NULL on every existing thread, so nothing that predates this carries
-- a dot, and the first indicator anyone sees is a reply that genuinely
-- arrived after it shipped.
--
-- What remains is pure DDL: nothing here reads or writes a row, so no
-- NO FORCE / FORCE ROW LEVEL SECURITY escape is needed. The UNIQUE constraint
-- builds its index without evaluating row security (see migration 296).
