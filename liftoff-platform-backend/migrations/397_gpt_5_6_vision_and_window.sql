-- Migration 397: the GPT-5.6 line can see, and its context window is recorded.
--
-- Migration 396 registered these three with no modality capability and no
-- window, because at the time neither had been investigated and both defaults
-- are the safe direction: an unmarked model is told in words that it cannot read
-- the picture, and a NULL window means the runtime may not end a session on it.
-- Both are now answered by the vendor, so both are recorded.
--
-- VISION. OpenAI's model page lists "Image input" under Supported Features for
-- all three, and OpenAI's own serving endpoint independently reports
-- input_modalities of text, image and file for each. Two sources agreeing is the
-- standard this estate applies before a capability is asserted — the same
-- standard migration 395 used for the Gemini rows.
--
-- Consequence worth stating: a workspace on OpenAI now RECEIVES images rather
-- than the text note. That is the whole point of the capability, and it is why
-- an unverified mark would have been the dangerous direction — a model wrongly
-- marked returns a 400 to somebody who has just attached a screenshot.
--
-- No `video`. Neither source claims video input for this line; `file` is not
-- video, and the blank is the correct answer rather than an omission.
--
-- WINDOW. 1,050,000 tokens, from OpenAI's model page and independently agreed by
-- the endpoint's published context_length. Migration 343 set the rule: a window
-- is recorded only when two sources agree, because recording one licenses the
-- runtime to retire a session on it, and a number we are unsure of is worse than
-- none. Both sources agree here, so this is no longer a hand-wave.
--
-- Scoped `WHERE context_window IS NULL`, exactly as 343 is, so re-running this
-- or applying it after an operator has corrected a value never overwrites a
-- deliberate entry with a historical one.
--
-- Max output (128,000) and the knowledge cutoff are published too and are NOT
-- recorded: this table has no column for either, and inventing one to hold a
-- fact nothing reads is how a column comes to advertise a capability that does
-- not exist.

BEGIN;

-- Append 'vision' where it is missing. Idempotent on re-run, and a no-op for a
-- row that already carries it.
UPDATE models
   SET capabilities = capabilities || '["vision"]'::jsonb,
       updated_at   = NOW()
 WHERE model_id IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna')
   AND NOT (capabilities @> '["vision"]'::jsonb);

UPDATE models
   SET context_window = 1050000,
       updated_at     = NOW()
 WHERE provider = 'openai'
   AND model_id IN ('gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna')
   AND context_window IS NULL;

COMMIT;
