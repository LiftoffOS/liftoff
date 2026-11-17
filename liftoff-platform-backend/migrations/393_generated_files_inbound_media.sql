-- Migration 393: let a PERSON's upload live in generated_files.
--
-- Everything in this table until now was produced BY an agent, and three parts
-- of its shape say so. Inbound media — a screenshot someone attaches to a chat
-- message — is the same kind of object stored in the same bucket and served by
-- the same download route, so it belongs here rather than in a second store
-- that would need its own signing, its own RLS and its own retention. What it
-- does not have is a producing agent, a thread on one particular table, or a
-- message that is guaranteed to exist.
--
-- 1. agent_id becomes nullable. It is `internal_agents.id` of the PRODUCER, and
--    an upload has none. Filling it with some arbitrary agent would put a
--    person's file in that agent's file list and in its audit trail.
--
-- 2. The conversation_id foreign key to agent_chat_threads is dropped. The
--    column has always been documented as "the thread this belongs to", but the
--    constraint says team chat specifically — and media now attaches on four
--    surfaces whose threads live in four different tables (and, for the Chief
--    AI Officer, in a different DATABASE, where no foreign key can reach). The
--    outbound helper already writes liftoff and insights thread ids through
--    this column, so the constraint was one produced picture away from a 23503
--    on a path that had already stored the bytes.
--
--    `surface` records which table the id points at, which is what the foreign
--    key was actually being used to communicate. Nullable: every existing row
--    predates media and is team chat by construction, and backfilling a value
--    nothing reads would be a claim this migration cannot check.
--
-- 3. uploaded_by_account_id + claimed_at make retention possible. Producer
--    media is owned by a message that always exists, because the producer
--    writes both in one call. An upload happens BEFORE the message is sent and
--    may never be sent at all — the person changes their mind, or closes the
--    tab. Without a claim marker there is no way to tell an abandoned upload
--    from one whose message is a second away, and the bucket accumulates both.

ALTER TABLE generated_files ALTER COLUMN agent_id DROP NOT NULL;

ALTER TABLE generated_files
  DROP CONSTRAINT IF EXISTS generated_files_conversation_id_fkey;

ALTER TABLE generated_files ADD COLUMN IF NOT EXISTS surface TEXT;

ALTER TABLE generated_files
  ADD COLUMN IF NOT EXISTS uploaded_by_account_id UUID REFERENCES accounts(id) ON DELETE SET NULL;

ALTER TABLE generated_files ADD COLUMN IF NOT EXISTS claimed_at TIMESTAMPTZ;

COMMENT ON COLUMN generated_files.agent_id IS
  'internal_agents.id of the agent that PRODUCED this file. NULL for a file a person uploaded.';

COMMENT ON COLUMN generated_files.surface IS
  'Which chat surface conversation_id belongs to: agent_chat | liftoff | insights | team_plan. NULL on rows written before migration 393, which are all team chat.';

COMMENT ON COLUMN generated_files.uploaded_by_account_id IS
  'accounts.id of the person who uploaded this file. NULL for agent-produced files.';

COMMENT ON COLUMN generated_files.claimed_at IS
  'When a sent message first referenced this upload. NULL means no message carries it yet; an unclaimed upload past the retention window is swept.';

-- The sweeper's only query: unclaimed uploads older than the window. Partial,
-- because the rows it must find are a vanishing fraction of the table and every
-- other row in it is claimed by construction.
CREATE INDEX IF NOT EXISTS generated_files_unclaimed_uploads_idx
  ON generated_files (created_at)
  WHERE claimed_at IS NULL AND uploaded_by_account_id IS NOT NULL;
