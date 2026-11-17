-- Migration 021: give back the words the person actually typed.
--
-- Until 020 shipped, Liftoff sent the Chief AI Officer one string:
--
--   [Context from the conversation so far: <summary>]\n\n<what the person typed>
--
-- and this service persisted the whole thing as the USER's row. Those rows stay
-- readable on any /share link, each showing a paragraph the person never wrote,
-- in Liftoff's voice, about them.
--
-- The boundary is not a guess. The old format is a literal prefix and a literal
-- `]` followed by a blank line, both written by code, so the split is exact.
-- Two shapes would make it unsafe: a row where `]\n\n` occurs more than once
-- (the first occurrence might not be the real boundary), and a row where the
-- split would leave the person with no message. The WHERE clause checks both
-- per row, so anything not of the expected shape is left alone instead of
-- mangled.
--
-- A person pasting a long article into the chat survives the split intact,
-- which is the case that matters most: a repair that truncated somebody's own
-- words would be worse than the defect.
--
-- REVERSIBLE. The original content is copied to team_plan_messages_pre_021
-- before anything changes, and that table is deliberately left behind.
--
-- RLS: team_plan_messages carries row-level security but not FORCE, and
-- migrations run as workforce_migrate, which owns it. An owner is exempt from a
-- non-forced policy, so this needs no NO FORCE / FORCE handling. The reads and
-- writes below are all owner-side and tenant-blind by design: this repairs
-- every workspace's rows in one pass.

BEGIN;

-- 1. The originals, and the working set. Every later statement reads from here
--    rather than the live table, because step 3 rewrites the column step 2
--    needs to read.
CREATE TABLE team_plan_messages_pre_021 AS
SELECT id, thread_id, created_at, content
FROM team_plan_messages
WHERE role = 'user'
  AND content LIKE '[Context from the conversation so far: %'
  -- The marker must fall AFTER the prefix, or it is not the one closing the
  -- summary.
  AND position(E']\n\n' in content) > length('[Context from the conversation so far: ')
  -- Never leave somebody's turn empty. A row that splits to nothing is not one
  -- of these, and it keeps whatever it has.
  AND btrim(substr(content, position(E']\n\n' in content) + 3)) <> '';

-- 2. The background, as the row it should always have been: assistant-side and
--    typed, exactly as the live path now writes it, so it renders as a
--    collapsed note rather than as speech.
--
--    One microsecond after the person's message, which is where the live path
--    puts it and what sorts it between that message and the reply to it.
--    Threads order by created_at, and the replies here are whole seconds away.
INSERT INTO team_plan_messages
  (thread_id, role, content, message_type, input_tokens, output_tokens, created_at)
SELECT
  b.thread_id,
  'assistant',
  'Liftoff shared background from the conversation so far' || E'\n\n' ||
    substr(
      b.content,
      length('[Context from the conversation so far: ') + 1,
      position(E']\n\n' in b.content) - length('[Context from the conversation so far: ') - 1
    ),
  'forwarded_context',
  0,
  0,
  b.created_at + interval '1 microsecond'
FROM team_plan_messages_pre_021 b;

-- 3. The person's row becomes the person's words.
UPDATE team_plan_messages m
SET content = substr(b.content, position(E']\n\n' in b.content) + 3)
FROM team_plan_messages_pre_021 b
WHERE m.id = b.id;

-- Verified inside the transaction, so a disagreement rolls the whole repair
-- back rather than leaving half of it applied.
DO $verify$
DECLARE
  backed_up integer;
  notes_written integer;
  still_fused integer;
  emptied integer;
BEGIN
  SELECT count(*) INTO backed_up FROM team_plan_messages_pre_021;

  -- Only the notes THIS migration wrote, matched back through the thread and
  -- the microsecond offset it used. A bare count of every forwarded_context row
  -- would also catch the ones the live code writes: the fix may already be
  -- serving, so one real delegation between that deploy and this migration would
  -- fail the check and block every deploy behind it.
  SELECT count(*) INTO notes_written
  FROM team_plan_messages m
  JOIN team_plan_messages_pre_021 b
    ON b.thread_id = m.thread_id
   AND m.created_at = b.created_at + interval '1 microsecond'
  WHERE m.message_type = 'forwarded_context';

  -- Nothing matching the old shape may survive, including rows the WHERE clause
  -- deliberately skipped: if one exists, this migration does not understand the
  -- data and should not claim to have fixed it.
  SELECT count(*) INTO still_fused
  FROM team_plan_messages
  WHERE role = 'user' AND content LIKE '[Context from the conversation so far: %';

  SELECT count(*) INTO emptied
  FROM team_plan_messages m
  JOIN team_plan_messages_pre_021 b ON b.id = m.id
  WHERE btrim(m.content) = '';

  IF notes_written <> backed_up THEN
    RAISE EXCEPTION 'migration 021: backed up % rows but wrote % notes', backed_up, notes_written;
  END IF;

  IF still_fused <> 0 THEN
    RAISE EXCEPTION 'migration 021: % user rows still carry the old fused format', still_fused;
  END IF;

  IF emptied <> 0 THEN
    RAISE EXCEPTION 'migration 021: % repaired rows were left with no message', emptied;
  END IF;
END
$verify$;

COMMIT;
