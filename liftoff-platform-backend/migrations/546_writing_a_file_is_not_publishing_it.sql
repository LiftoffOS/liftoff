-- Migration 546: a file can be written without being published, and published
-- later by a deliberate act.
--
-- A custom API connection answers with bytes as readily as with JSON, and those
-- bytes go to this store rather than into a model's context. The file is stored
-- and attributed to the AI team that fetched it, and then nobody can see it:
-- the call that fetched it carries no conversation, so no card is ever
-- appended. There was no way to append one afterwards either. Every writer of a
-- `file_output` row creates the file in the same request
-- (src/generated-files/router.ts:157 has two call sites, both immediately after
-- an insert), so a file that arrived without a conversation could never be
-- shown to anyone. The runtime meanwhile tells models a card may be "forwarded
-- through any other tool that takes a generatedFileId"
-- (src/tools/standard-tools.ts) — a tool that has never existed.
--
-- The rule this encodes, which is the one the platform we model the connector
-- design on states plainly: writing a file never makes it visible; visibility
-- is always a separate, explicit act. Their file reference carries a path and
-- nothing else, and which conversation shows it is decided by where the reply
-- is delivered. That is why no conversation id travels with a file here either,
-- and why the connector-service execute contract does not gain a thread field.
--
-- Two columns.
--
-- 1. `generated_files.discard_after` — the tier that was missing. NULL means an
--    artifact: somebody published it and it is kept. Non-null means staged: the
--    bytes exist, nobody has published them, and they go at that time.
--    PRESENTING A FILE CLEARS IT, so publishing is what makes a file permanent.
--    Without this, every file fetched from a provider and never shown to anyone
--    is kept forever.
--
--    Named `discard_after` rather than `expires_at` on purpose:
--    `expires_at` is in the schema-reachability ratchet's
--    UNATTRIBUTABLE_COLUMN_NAMES, so a column called that passes the gate
--    without proving anything reads it. This one has to earn it.
--
-- 2. `files` on the two assistant message tables — where a card lives on a
--    surface that is not team chat. NOT `attachments`: ADR-051 settled that
--    that column means what the PERSON sent, and that overloading it is exactly
--    what a produced artifact must not do. Media got its own column for this
--    reason; a file card gets one for the same reason. Sparse like `media`
--    beside it: no files stores NULL, and the read path maps both to [].
--
-- The team-chat surface needs no column. Its card already rides `attachments`
-- on agent_chat_messages, where that column has always meant what the assistant
-- produced, and that shape is fixed by every reader of it.
--
-- RLS: ADD COLUMN only, no row is written, so no NO FORCE / FORCE wrapper is
-- needed here (contrast 545, which writes a system-agent row).

BEGIN;

-- ── 1. The staged tier ────────────────────────────────────────────────

ALTER TABLE generated_files
  ADD COLUMN IF NOT EXISTS discard_after TIMESTAMPTZ;

COMMENT ON COLUMN generated_files.discard_after IS
  'When staged bytes are discarded. NULL means the file was published and is kept. '
  'Presenting a file clears this column: publishing is what makes a file permanent.';

-- Partial, because the sweep only ever asks for the staged rows and they are
-- the minority. A full index on a mostly-NULL column would be paid for on
-- every insert and read on none of them.
CREATE INDEX IF NOT EXISTS generated_files_discard_after_idx
  ON generated_files (discard_after)
  WHERE discard_after IS NOT NULL;

-- ── 2. Where a card lives on the assistant surfaces ───────────────────

ALTER TABLE liftoff_chat_messages
  ADD COLUMN IF NOT EXISTS files JSONB;

COMMENT ON COLUMN liftoff_chat_messages.files IS
  'File cards presented into this message. Its own column so `attachments` (what the '
  'person sent) and `visualization_blocks` (what was drawn) keep their meanings.';

ALTER TABLE insights_chat_messages
  ADD COLUMN IF NOT EXISTS files JSONB;

COMMENT ON COLUMN insights_chat_messages.files IS
  'File cards presented into this message. Its own column so `attachments` (what the '
  'person sent) and `visualization_blocks` (what was drawn) keep their meanings.';

COMMIT;
