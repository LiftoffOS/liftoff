-- Adds title-generation tracking columns to all three thread tables.
--
-- title_generated_at: TIMESTAMPTZ, NULL = never AI-set. Set when the
--   shared thread-title-generation service writes an AI title.
-- title_source: 'ai' | 'user' | NULL. NULL means placeholder/untouched
--   (includes the frontend's `deriveThreadTitle()` truncated-first-message
--   fallback). 'ai' = set by the shared title generator. 'user' is reserved
--   for a future user-rename endpoint — the AI UPDATE SQL uses
--   `title_source IS DISTINCT FROM 'user'` so a future rename is safe from
--   AI overwrite.
--
-- Partial indexes support a future sweeper that re-tries title generation
-- for threads that missed all in-flight retries (plan D4, deferred).

ALTER TABLE insights_chat_threads
  ADD COLUMN IF NOT EXISTS title_generated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS title_source TEXT CHECK (title_source IN ('ai', 'user'));

ALTER TABLE team_plan_threads
  ADD COLUMN IF NOT EXISTS title_generated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS title_source TEXT CHECK (title_source IN ('ai', 'user'));

ALTER TABLE agent_chat_threads
  ADD COLUMN IF NOT EXISTS title_generated_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS title_source TEXT CHECK (title_source IN ('ai', 'user'));

-- Partial indexes for the future sweeper. Non-CONCURRENTLY to keep the
-- migration inside a transaction if the runner wraps one; these tables
-- are small enough that the brief lock is negligible.
CREATE INDEX IF NOT EXISTS idx_ict_needs_title
  ON insights_chat_threads (created_at)
  WHERE title_source IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_tpt_needs_title
  ON team_plan_threads (created_at)
  WHERE title_source IS NULL AND deleted_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_act_needs_title
  ON agent_chat_threads (created_at)
  WHERE title_source IS NULL AND deleted_at IS NULL;
