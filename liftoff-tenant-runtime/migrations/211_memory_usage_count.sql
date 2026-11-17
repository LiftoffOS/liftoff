-- migrations/211_memory_usage_count.sql
--
-- Adds usage_count to memories so semantic-dedup writes increment a counter
-- instead of being dropped. Feeds the knowledge-promoter's new high-usage path.
--
-- (Numbered 211 rather than 206 because node-pg-migrate refuses to insert a
--  migration behind ones already applied.)

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS usage_count INTEGER NOT NULL DEFAULT 1
    CHECK (usage_count >= 1);

-- Partial index — only memories that have been seen more than once are
-- candidates for the high-usage promotion query. Keeps the index small.
CREATE INDEX IF NOT EXISTS idx_memories_usage_count
  ON memories (tenant_id, layer, usage_count DESC, updated_at DESC)
  WHERE superseded_by IS NULL AND usage_count > 1;
