-- Migration 388: give back the words the person actually typed.
--
-- Until 387 shipped, Liftoff sent a colleague one string:
--
--   [Context from the conversation so far: <summary>]\n\n<what the person typed>
--
-- and the Insights Manager persisted the whole thing as the USER's row. Such
-- rows are readable on any /share link: a paragraph the person never wrote,
-- in Liftoff's voice, about them.
--
-- The boundary is not a guess. The old format is a literal prefix and a literal
-- `]` followed by a blank line, both written by code, so the split is exact.
--
-- Two shapes would make it unsafe: rows where `]\n\n` occurs more than once,
-- which would make the first occurrence possibly not the real boundary, and
-- rows where the split would leave the person with no message at all. The
-- WHERE clause below rejects both per row, so a row that does not match the
-- shape is left alone instead of being mangled.
--
-- agent_chat_messages is deliberately NOT repaired here. Only team delegations
-- would write fused rows there, and it is FORCE row-level-security, so
-- repairing it would mean a data migration on a policied table. If fused rows
-- ever appear there, they need their own migration with that handling, and the
-- query to find them is the WHERE clause below.
--
-- REVERSIBLE. The original content is copied to insights_chat_messages_pre_388
-- before anything is changed. That table is the record of what was overwritten
-- and is deliberately left behind; `*_pre_NNN` is the convention the schema
-- reachability test already skips.

BEGIN;

-- 1. The originals, and the working set. Every later statement reads from here
--    rather than from the live table, because step 3 rewrites the column that
--    step 2 needs to read.
CREATE TABLE insights_chat_messages_pre_388 AS
SELECT id, thread_id, created_at, content
FROM insights_chat_messages
WHERE role = 'user'
  AND content LIKE '[Context from the conversation so far: %'
  -- The marker must fall AFTER the prefix, or it is not the one that closes
  -- the summary.
  AND position(E']\n\n' in content) > length('[Context from the conversation so far: ')
  -- Never leave somebody's turn empty. A row that splits to nothing is not one
  -- of these; it is something else, and it keeps whatever it has.
  AND btrim(substr(content, position(E']\n\n' in content) + 3)) <> '';

-- 2. The background, as the row it should always have been. Attributed to the
--    assistant side and typed, exactly as the live path now writes it, so it
--    renders as a collapsed note rather than as speech.
--
--    One microsecond after the person's message, which is where the live path
--    puts it (the two inserts run back to back) and what makes it sort between
--    that message and the reply to it. Threads are ordered by created_at, and
--    the replies here are whole seconds away.
INSERT INTO insights_chat_messages
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
FROM insights_chat_messages_pre_388 b;

-- 3. The person's row becomes the person's words.
UPDATE insights_chat_messages m
SET content = substr(b.content, position(E']\n\n' in b.content) + 3)
FROM insights_chat_messages_pre_388 b
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
  SELECT count(*) INTO backed_up FROM insights_chat_messages_pre_388;

  -- Only the notes THIS migration wrote, matched back through the thread and
  -- the microsecond offset it used. A bare count of every forwarded_context row
  -- would also catch the ones the live code writes, and the fix may already be
  -- serving: one real delegation between the deploy and this migration would
  -- fail the check and block every deploy behind it.
  SELECT count(*) INTO notes_written
  FROM insights_chat_messages m
  JOIN insights_chat_messages_pre_388 b
    ON b.thread_id = m.thread_id
   AND m.created_at = b.created_at + interval '1 microsecond'
  WHERE m.message_type = 'forwarded_context';

  -- Nothing matching the old shape may survive, including rows the WHERE
  -- clause deliberately skipped: if one exists, this migration does not
  -- understand the data and should not claim to have fixed it.
  SELECT count(*) INTO still_fused
  FROM insights_chat_messages
  WHERE role = 'user' AND content LIKE '[Context from the conversation so far: %';

  SELECT count(*) INTO emptied
  FROM insights_chat_messages m
  JOIN insights_chat_messages_pre_388 b ON b.id = m.id
  WHERE btrim(m.content) = '';

  IF notes_written <> backed_up THEN
    RAISE EXCEPTION 'migration 388: backed up % rows but wrote % notes', backed_up, notes_written;
  END IF;

  IF still_fused <> 0 THEN
    RAISE EXCEPTION 'migration 388: % user rows still carry the old fused format', still_fused;
  END IF;

  IF emptied <> 0 THEN
    RAISE EXCEPTION 'migration 388: % repaired rows were left with no message', emptied;
  END IF;
END
$verify$;

COMMIT;
