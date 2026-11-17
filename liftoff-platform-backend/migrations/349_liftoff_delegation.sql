-- Migration 349: Liftoff brings a colleague into the thread rather than
-- pointing the person at one.
--
-- When someone asks Liftoff for something a colleague owns, Liftoff calls that
-- colleague and it answers into the thread the person is already in, with its
-- full normal capability. Nobody is navigated anywhere. The roster is the same
-- one the dashboard composer's mention picker offers:
--
--   caio      the Chief AI Officer, which designs and changes AI teams. Its turn
--             runs in workforce-service, against a thread in THAT service's
--             database.
--   insights  the Insights Manager, which answers from real workspace data. Its
--             turn runs in this service, against insights_chat_threads.
--   team      any active AI team in the workspace, one row per internal_agents
--             id. Its turn runs through agent-chat, against agent_chat_threads.
--
-- ── Why a table and not a column ───────────────────────────────────────
--
-- Every one of those turns is bound to a thread on its own surface, and there is
-- no transcript input on any of them: a colleague can only be reached through a
-- thread it already owns. So a Liftoff conversation has to remember which thread
-- it is using with each colleague, and reuse it, or the second request in a
-- conversation starts the colleague from nothing.
--
-- A single workforce_thread_id column would only ever have modelled the first of
-- the three. A conversation can involve several colleagues over its life, and
-- can involve several different teams, so the pairing is one-to-many and belongs
-- in its own table. Adding one column per colleague kind would also mean a
-- migration every time the roster grows, and the roster grows whenever the
-- customer creates a team.
CREATE TABLE liftoff_thread_delegations (
  id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  liftoff_thread_id   UUID NOT NULL
                        REFERENCES liftoff_chat_threads(id) ON DELETE CASCADE,
  -- Which kind of colleague. 'caio' and 'insights' are singletons, so they carry
  -- no target_id; 'team' names one AI team.
  target_kind         VARCHAR(16) NOT NULL
                        CHECK (target_kind IN ('caio', 'insights', 'team')),
  -- The team, for target_kind = 'team', and NULL for the two singletons. The
  -- foreign key is real and cascades: a pairing with a team that no longer
  -- exists is not history worth keeping, it is a row that would send the next
  -- request into a thread nobody owns.
  target_id           UUID REFERENCES internal_agents(id) ON DELETE CASCADE,
  -- The paired thread on the colleague's own surface: team_plan_threads.id in
  -- the workforce-service database for 'caio', insights_chat_threads.id for
  -- 'insights', agent_chat_threads.id for 'team'. No foreign key, and it could
  -- not have one: the three live in three different tables and one of them is in
  -- another database entirely.
  delegate_thread_id  UUID NOT NULL,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- One pairing per conversation per colleague. Written as two partial indexes
-- rather than one UNIQUE (liftoff_thread_id, target_kind, target_id), because
-- NULLs compare distinct in a unique index: with target_id NULL on both
-- singletons, that constraint would happily allow a second 'caio' pairing and
-- the conversation would silently fork the Chief AI Officer's plan in two.
CREATE UNIQUE INDEX idx_liftoff_delegation_singleton
  ON liftoff_thread_delegations (liftoff_thread_id, target_kind)
  WHERE target_id IS NULL;
CREATE UNIQUE INDEX idx_liftoff_delegation_team
  ON liftoff_thread_delegations (liftoff_thread_id, target_kind, target_id)
  WHERE target_id IS NOT NULL;

-- Supports the cascade from liftoff_chat_threads, which would otherwise scan.
CREATE INDEX idx_liftoff_delegation_thread
  ON liftoff_thread_delegations (liftoff_thread_id);

-- ── Which colleague wrote a message ────────────────────────────────────
--
-- A reply written by the Insights Manager is not a reply written by Liftoff, and
-- the transcript has to be able to say which, by name, because the frontend
-- labels the bubble with it.
--
-- Two columns, because the two questions are different. `author` is identity and
-- is what code matches on; it holds the same vocabulary the mention picker
-- already uses, so a message and a mention name the same colleague the same way:
-- 'caio', 'insights', or an internal_agents id for a team. NULL means Liftoff
-- itself, which is why the column is nullable rather than defaulted: stamping
-- 'liftoff' on every historical row would be a backfill that buys nothing.
--
-- `author_label` is the name the person actually saw. It is denormalised on
-- purpose: a team can be renamed or deleted, and a transcript that then relabels
-- or blanks a reply it has already shown is rewriting history. It also means the
-- frontend can render an old thread without resolving ids it may no longer be
-- able to resolve.
ALTER TABLE liftoff_chat_messages
  ADD COLUMN author       VARCHAR(64),
  ADD COLUMN author_label VARCHAR(200);

COMMENT ON COLUMN liftoff_chat_messages.author IS
  'Which colleague wrote this message: ''caio'', ''insights'', or an internal_agents.id for a team. NULL means Liftoff itself. Same vocabulary as the frontend mention roster.';
COMMENT ON COLUMN liftoff_chat_messages.author_label IS
  'The colleague''s display name at the time of writing, e.g. ''Chief AI Officer'' or the team''s role. Denormalised so a renamed or deleted team does not relabel a reply the person already read.';

-- ── Visualization blocks ───────────────────────────────────────────────
--
-- The Chief AI Officer emits ```org_chart fences when it proposes a team
-- structure, and the Insights Manager emits charts and tables. Both surfaces
-- strip those fences out of the text in their streaming parser and deliver them
-- ONLY as content_block events, so a message persisted as text alone loses them
-- outright: on screen once, gone on the next reload.
--
-- Migration 348 deliberately left this column off because Liftoff answers in
-- plain text. That is still true of Liftoff. It is not true of the colleagues
-- now speaking in its threads.
ALTER TABLE liftoff_chat_messages
  ADD COLUMN visualization_blocks JSONB;

COMMENT ON COLUMN liftoff_chat_messages.visualization_blocks IS
  'Blocks the reply rendered beside its text, in the shape of src/insights/shared-types.ts VisualizationBlock. Written only by a delegated turn; the emitting parser has already lifted them out of content.';

-- ── Row-level security ─────────────────────────────────────────────────
--
-- Nothing to enable, and it is worth writing down why rather than leaving the
-- next reader to work it out.
--
-- The estate-wide DO-loops that enable RLS on every tenant_id table (migrations
-- 095, 287, 289) have already run and will never see anything created after
-- them, which is why 348 wrote its own policies out by hand. But nothing here
-- needs one:
--
--   liftoff_chat_messages already exists and deliberately has NO policy. It
--   carries no tenant_id and inherits tenancy from its thread, which the
--   repository resolves and permission-checks before any read or write.
--   Migration 200's verification suite asserts that absence explicitly. A policy
--   is a row predicate, not a column list, so adding columns changes nothing.
--
--   liftoff_thread_delegations is new, and follows the same rule for the same
--   reason: no tenant_id column, tenancy inherited from liftoff_thread_id, and
--   every read and write in the repository goes through a thread the caller has
--   already been permission-checked against. Its target_id foreign key points at
--   internal_agents, which IS tenant-scoped, and the resolver checks the team
--   belongs to the caller's tenant before a pairing is ever written.
--
-- The one thing that would change this is giving either table a tenant_id, at
-- which point both the DO-loop convention and the census in migration 200's
-- suite would expect a policy written out here.
