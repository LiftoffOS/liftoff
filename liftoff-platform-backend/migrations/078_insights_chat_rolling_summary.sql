-- Adds a rolling conversation summary to insights_chat_threads for Phase 6
-- of the insights chat.
--
-- On threads longer than ~10 messages, the chat service periodically
-- summarizes older messages into a structured JSON snapshot of the form
--
--   {
--     "userIntent":        "Investigating Q1 cost spike on Salesforce Sync",
--     "keyFacts":          ["Cost spiked 34% starting 2026-03-15", ...],
--     "openQuestions":     ["Was there a config change on 2026-03-15?", ...],
--     "previousFindings":  ["Top cost driver: extra retries from rate limiting"],
--     "nextSteps":         ["Compare against pre-March connector_health"],
--     "summarizedThrough": "2026-04-05T14:22:18.412Z",
--     "messageCount":       14
--   }
--
-- ...which the next turn injects into the context budget's `rollingSummary`
-- section. This preserves continuity across long investigations without
-- shipping the entire history to the LLM every turn.
--
-- JSONB so fields are queryable by operators during debugging, and to get
-- typed read-back from pg without manual JSON parsing. Nullable — short
-- threads never need a summary and keeping the column sparse keeps list
-- queries cheap (the default SELECT for list views doesn't include this
-- column).

ALTER TABLE insights_chat_threads
  ADD COLUMN IF NOT EXISTS rolling_summary JSONB;
