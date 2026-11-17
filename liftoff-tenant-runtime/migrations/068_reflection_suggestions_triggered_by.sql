-- Tag reflection suggestions with the trigger type that
-- produced them. This lets downstream consumers (especially a future
-- auto-applier) distinguish suggestions that originated from flagged late
-- feedback — those must always go through an explicit human review, never
-- auto-apply, because the underlying signal is a single post-hoc rejection
-- rather than a statistically-stable density of evidence.
--
-- Existing rows are backfilled to NULL (unknown). The application layer
-- treats NULL as "not flagged_feedback" for safety.
ALTER TABLE reflection_suggestions
  ADD COLUMN IF NOT EXISTS triggered_by TEXT;

CREATE INDEX IF NOT EXISTS idx_reflection_suggestions_triggered_by
  ON reflection_suggestions (triggered_by)
  WHERE triggered_by IS NOT NULL;
