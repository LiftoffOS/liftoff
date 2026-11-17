-- 550: work an assistant set going rides the continuation's own rails.
--
-- 549 gave background work a table of its own and an in-process runner: the
-- child ran on the instance that started it, so a result died with the
-- instance and a later turn on another instance would have waited forever. It
-- was never used — nothing shipped against it — and this replaces it rather
-- than leaving two mechanisms for one idea.
--
-- The rails were already here. A continuation (517) is a durable row, a Cloud
-- Task on a queue whose retries wait for a busy thread, a worker that claims
-- it under a lease, takes the surface's own turn lock, runs the assistant, and
-- posts the reply into the thread. That is every property background work
-- needs, including the one that matters most: because it takes the thread's
-- lock like any other turn, a busy conversation makes it WAIT rather than
-- land on top of somebody mid-sentence. Push delivery that structurally
-- cannot interrupt.
--
-- So a continuation gains a kind. 'continuation' is the existing behaviour and
-- the default, so every row already written keeps its meaning. 'background
-- work' carries its own brief and differs in three ways the worker enforces:
--
--   its BRIEF is the objective, where a continuation carries on with what was
--   already in progress;
--
--   a person writing DOES NOT CANCEL IT. A continuation is superseded by the
--   next thing the person says, and rightly: they moved on. Background work is
--   the opposite — they asked for it and then carried on talking;
--
--   it DOES NOT CHAIN. Nobody asked for a second helping.
--
-- `origin_message_id` still points at the message that set it going, so the
-- ordinal counting and the per-message cap keep working unchanged; background
-- work is simply never queued more than once against its own message.

ALTER TABLE chat_continuations
  ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'continuation'
    CHECK (kind IN ('continuation', 'background_work')),
  -- The whole job, in the assistant's words, standing on its own: whoever
  -- picks it up does not see the conversation. Empty for a continuation,
  -- which has no brief of its own.
  ADD COLUMN IF NOT EXISTS brief TEXT NOT NULL DEFAULT '';

COMMENT ON COLUMN chat_continuations.kind IS
  'continuation carries on work a bound closed; background_work is a job the assistant set going and is not waiting for. The difference decides the objective, whether a person writing cancels it, and whether it chains.';
COMMENT ON COLUMN chat_continuations.brief IS
  'The whole job for background_work, standing on its own. Empty for a continuation.';

-- 549's table, dropped unused. Its work is a continuation now.
DROP TABLE IF EXISTS background_work;
