-- 031: turn identity and turn embeddings for the Chief AI Officer's threads
--
-- The other three chat surfaces can search a person's earlier conversations:
-- AI team chat since platform-backend's 294/295, Liftoff and the Insights
-- Manager since its 547. This surface could not, because its threads live in
-- THIS database and nothing here had a turn to key a search to — the CAIO could
-- LIST and READ its conversations (conversations__list / conversation__read) but
-- not search them by words.
--
-- Mirrors platform-backend's 294 and 547 so the four surfaces answer the same
-- question the same way: the TURN is the identity boundary, because a thread here
-- is shared workspace-wide and several people take part in one, so who spoke is a
-- property of the exchange and not of the thread.
--
-- `id` carries no default: it is the turnId the chat service already mints for
-- every turn (chat-service.ts mints one unconditionally, so unlike Liftoff's
-- streaming-only id there is nothing to fall back to). ON CONFLICT DO NOTHING at
-- the call site makes the insert idempotent under a retry.
--
-- turn_id on a message is NULLABLE AND MEANS SOMETHING: a row written inside a
-- turn carries it, a row written ABOUT the conversation or outside one does not.
--
-- Bare UUIDs for account_id, as every table here does: accounts and tenants live
-- in platform-backend's database, so there is nothing to foreign-key them to
-- (the trade migration 014 documents).
--
-- RLS in the 014/024 style: ENABLE + policy with WITH CHECK, and deliberately NOT
-- FORCE. team_plan_threads is un-FORCEd and migration 017's definer function
-- depends on the owner being exempt; a FORCE here would be inconsistent with the
-- table it hangs off and would break the sweep below, which enumerates across
-- tenants as the owner.

-- pgvector. Available on this instance — it is the same Cloud SQL instance
-- platform-backend uses, where vector(768) has been in service since its
-- migration 295 — but it has never been enabled in the `workforce` database.
-- Creating an extension is proven for this migrate role: migration 019 does it
-- for pg_partman.
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE team_plan_turns (
  id           UUID PRIMARY KEY,               -- the chat service's turnId
  tenant_id    UUID NOT NULL,
  thread_id    UUID NOT NULL,
  account_id   UUID,                           -- who spoke; NULL is never embedded
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  content_embedding          vector(768),
  content_embedding_provider TEXT,
  content_embedding_model    TEXT,
  -- Rides team_plan_threads_id_tenant_key (migration 014), the same guarantee
  -- presence and the read markers use: a turn cannot be pointed at another
  -- tenant's thread even if tenant_id were wrong.
  FOREIGN KEY (thread_id, tenant_id)
    REFERENCES team_plan_threads (id, tenant_id) ON DELETE CASCADE,
  UNIQUE (id, tenant_id)
);

-- What a search filters on: this tenant, this person, newest first. Partial,
-- because a turn with no account is never searched for.
CREATE INDEX idx_team_plan_turns_recall
  ON team_plan_turns (tenant_id, account_id, created_at DESC)
  WHERE account_id IS NOT NULL;
CREATE INDEX idx_team_plan_turns_thread ON team_plan_turns (thread_id);
-- What the embed sweep claims next. Partial, so it stays the size of the backlog
-- rather than the size of the table.
CREATE INDEX idx_team_plan_turns_unembedded ON team_plan_turns (created_at)
  WHERE content_embedding IS NULL AND account_id IS NOT NULL;

-- NO vector index, following platform-backend's 295: retrieval filters by
-- (tenant, account, created_at) through the index above and exact-sorts a small
-- per-person history. A global HNSW index post-filters an approximate scan and
-- can miss or empty out results for selective predicates.

ALTER TABLE team_plan_turns ENABLE ROW LEVEL SECURITY;
CREATE POLICY team_plan_turns_tenant_isolation ON team_plan_turns
  USING (tenant_id = current_setting('app.current_tenant_id', true)::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id', true)::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON team_plan_turns TO workforce_app;

-- The message -> turn link.
--
-- NOT VALID: a validated ADD runs an initial-check scan of team_plan_messages
-- under lock, and that scan cannot find a violation — turn_id is born here, so
-- every existing row is NULL and satisfies the constraint vacuously. Ongoing
-- enforcement is complete either way, since RI triggers fire on new and updated
-- rows regardless of validation state. Do NOT add VALIDATE CONSTRAINT later: it
-- buys the same nothing for the same scan.
--
-- ADD COLUMN is a schema change rather than a row write, so it needs none of the
-- FORCE / NO FORCE handling a data migration on a policied table would (the same
-- note 020/022/023/024 carry).
ALTER TABLE team_plan_messages ADD COLUMN IF NOT EXISTS turn_id UUID;
ALTER TABLE team_plan_messages ADD CONSTRAINT team_plan_messages_turn_fk
  FOREIGN KEY (turn_id) REFERENCES team_plan_turns (id) ON DELETE SET NULL NOT VALID;
CREATE INDEX idx_team_plan_messages_turn ON team_plan_messages (turn_id)
  WHERE turn_id IS NOT NULL;

-- No backfill, deliberately, on the same argument migration 024 makes: existing
-- rows keep turn_id NULL, so nothing that predates this is searchable, and the
-- first conversation a search can find is one held after it shipped. A backfill
-- would have to guess turn boundaries from timestamps, and a wrong guess is a
-- quote attributed to the wrong exchange.
