-- Migration 005: CAIO memory timestamp column
--
-- The rolling_summary JSONB on team_plan_threads already stores CAIO memory
-- under the 'memory' key (set by the memory_save tool). This migration adds
-- a dedicated timestamp column so that cache invalidation logic can cheaply
-- detect when memory was last written without parsing the JSONB blob.
--
-- No new table is needed: memory is stored inline in rolling_summary.memory
-- as a {entries: [{id, content, layer, scopeKey, tags, savedAt}]} object.
-- The memory_save and memory_retrieve tools in src/workforce-plans/tools/
-- read and write this structure directly via the chat repository.

ALTER TABLE team_plan_threads
  ADD COLUMN IF NOT EXISTS caio_memory_updated_at TIMESTAMPTZ;

COMMENT ON COLUMN team_plan_threads.caio_memory_updated_at IS
  'Timestamp of the last memory_save write into rolling_summary.memory. '
  'Used for cache invalidation without parsing the JSONB blob.';
