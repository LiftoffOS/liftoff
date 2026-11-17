-- Migration 030: a file can be shown into a Chief AI Officer conversation.
--
-- The control plane gained one act: showing a file that is already in the
-- workspace to the person in the conversation (platform-backend migration 546).
-- Writing a file and publishing it are separate decisions, and until that
-- existed a file stored without a conversation — what a custom API answered
-- with, what a run nobody was watching produced — could never be put in front
-- of anybody.
--
-- The other three surfaces keep their cards in a `files` column of their own.
-- This is the same column on this service's own table, because the Chief AI
-- Officer's messages live in this database and nowhere else.
--
-- NOT `attachments`: on this table that column means what the PERSON sent, and
-- a produced artifact borrowing it is the drift that put media in its own
-- column two migrations ago. Sparse like `media` beside it — a message
-- carrying none stores NULL, and the read path maps NULL and a non-array alike
-- to the empty list, so every row written before this reads back unchanged.

BEGIN;

ALTER TABLE team_plan_messages
  ADD COLUMN IF NOT EXISTS files JSONB;

COMMENT ON COLUMN team_plan_messages.files IS
  'File cards shown into this message. Its own column so `attachments` (what the '
  'person sent) and `visualization_blocks` (what was drawn) keep their meanings.';

COMMIT;
