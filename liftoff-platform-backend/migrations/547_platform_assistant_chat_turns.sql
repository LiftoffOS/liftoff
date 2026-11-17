-- Turn identity for the two in-process platform assistants, so every chat
-- surface has the unit recall is keyed to.
--
-- agent_chat_turns (294) made the TURN the identity boundary for AI team chat:
-- threads are shared and can mix people, so the person who spoke is a property
-- of the turn rather than of the thread. 295 hung an embedding on it. Liftoff
-- and the Insights Manager had no such unit, so recall across a person's own
-- earlier conversations existed on one surface out of four. These two tables are
-- that unit, mirroring 294 and 295 column for column so ONE query serves every
-- surface.
--
-- `id` CARRIES NO DEFAULT, exactly as 294's does not: the row is keyed by the
-- turnId the chat service already owns and passes through persistence, which is
-- what makes the insert idempotent under a retry (ON CONFLICT (id) DO NOTHING)
-- and what lets every producer writing inside one turn stamp the same id.
--
-- turn_id ON A MESSAGE IS NULLABLE AND MEANS SOMETHING. A row written inside a
-- turn carries it; a row written ABOUT the conversation or outside any turn — a
-- status line, a presented file, an attached medium arriving on its own — does
-- not, and NULL is the correct answer for those. This is agent_chat_messages'
-- existing behaviour, where status rows also carry no turn.
--
-- WHICH TABLES HAVE RLS, because it is not uniform here and the difference drives
-- the statements below. The two TURNS tables carry tenant_id, so they get
-- ENABLE + FORCE + a tenant policy (INV-PB-001) and every query on them must go
-- through withTenantScope. The two MESSAGE tables carry no tenant_id at all —
-- they are scoped through their thread — so they have no policy, which is why
-- their existing readers may use an unscoped pool and why the note below is NOT
-- 294's RLS argument.
--
-- NOT VALID on the two message FKs, for a reason of its own: a validated ADD runs
-- an initial-check scan of the referencing table under lock, and that scan cannot
-- find a violation. turn_id is born in this migration, so every existing row is
-- NULL and satisfies the constraint vacuously. Ongoing enforcement is complete
-- either way — RI triggers fire on new and updated rows regardless of validation
-- state. Do NOT add VALIDATE CONSTRAINT later: it buys the same nothing for the
-- same scan.
--
-- Composite FKs are tenant-consistent throughout. Both thread tables already
-- carry UNIQUE (id, tenant_id) (migrations 433 and 434).
--
-- NO vector index, following 295: retrieval filters by
-- (tenant, sender, created_at) and exact-sorts a small per-person history. A
-- global HNSW index post-filters an approximate scan and can miss or empty out
-- results for selective predicates.

CREATE TABLE liftoff_chat_turns (
  id UUID PRIMARY KEY,                              -- the service's turnId; no default
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  thread_id UUID NOT NULL,
  sender_account_id UUID REFERENCES accounts(id),   -- NULL = no resolved sender; never embedded
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  content_embedding vector(768),
  content_embedding_provider TEXT,
  content_embedding_model TEXT,
  FOREIGN KEY (thread_id, tenant_id)
    REFERENCES liftoff_chat_threads (id, tenant_id) ON DELETE CASCADE,
  UNIQUE (id, tenant_id)
);
CREATE INDEX idx_liftoff_turns_recall ON liftoff_chat_turns
  (tenant_id, sender_account_id, created_at DESC)
  WHERE sender_account_id IS NOT NULL;
CREATE INDEX idx_liftoff_turns_thread ON liftoff_chat_turns (thread_id);
-- What the embed sweep claims next. Partial, so it stays the size of the
-- backlog rather than the size of the table.
CREATE INDEX idx_liftoff_turns_unembedded ON liftoff_chat_turns (created_at)
  WHERE content_embedding IS NULL AND sender_account_id IS NOT NULL;

CREATE TABLE insights_chat_turns (
  id UUID PRIMARY KEY,
  tenant_id UUID NOT NULL REFERENCES tenants(id),
  thread_id UUID NOT NULL,
  sender_account_id UUID REFERENCES accounts(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  content_embedding vector(768),
  content_embedding_provider TEXT,
  content_embedding_model TEXT,
  FOREIGN KEY (thread_id, tenant_id)
    REFERENCES insights_chat_threads (id, tenant_id) ON DELETE CASCADE,
  UNIQUE (id, tenant_id)
);
CREATE INDEX idx_insights_turns_recall ON insights_chat_turns
  (tenant_id, sender_account_id, created_at DESC)
  WHERE sender_account_id IS NOT NULL;
CREATE INDEX idx_insights_turns_thread ON insights_chat_turns (thread_id);
CREATE INDEX idx_insights_turns_unembedded ON insights_chat_turns (created_at)
  WHERE content_embedding IS NULL AND sender_account_id IS NOT NULL;

ALTER TABLE liftoff_chat_messages ADD COLUMN turn_id UUID;
ALTER TABLE liftoff_chat_messages ADD CONSTRAINT liftoff_chat_messages_turn_fk
  FOREIGN KEY (turn_id) REFERENCES liftoff_chat_turns (id) ON DELETE SET NULL NOT VALID;
CREATE INDEX idx_lcm_turn ON liftoff_chat_messages (turn_id)
  WHERE turn_id IS NOT NULL;

ALTER TABLE insights_chat_messages ADD COLUMN turn_id UUID;
ALTER TABLE insights_chat_messages ADD CONSTRAINT insights_chat_messages_turn_fk
  FOREIGN KEY (turn_id) REFERENCES insights_chat_turns (id) ON DELETE SET NULL NOT VALID;
CREATE INDEX idx_icm_turn ON insights_chat_messages (turn_id)
  WHERE turn_id IS NOT NULL;

-- RLS on the turns tables (INV-PB-001). Census entries go in
-- migrations/__tests__/200_verification.integration.test.ts, and the table list
-- the lint rule reads is regenerated with `npm run rls:tables`.
ALTER TABLE liftoff_chat_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE liftoff_chat_turns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON liftoff_chat_turns
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);

ALTER TABLE insights_chat_turns ENABLE ROW LEVEL SECURITY;
ALTER TABLE insights_chat_turns FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON insights_chat_turns
  USING (tenant_id = current_setting('app.current_tenant_id')::uuid)
  WITH CHECK (tenant_id = current_setting('app.current_tenant_id')::uuid);
