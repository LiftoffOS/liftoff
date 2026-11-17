-- migrations/130_memory_summary_levels.sql

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS summary_level SMALLINT NOT NULL DEFAULT 0
    CHECK (summary_level >= 0 AND summary_level <= 2),
  ADD COLUMN IF NOT EXISTS summarizes UUID[] NOT NULL DEFAULT '{}';

CREATE INDEX IF NOT EXISTS idx_memories_summary_level
  ON memories(tenant_id, summary_level, created_at DESC)
  WHERE superseded_by IS NULL;

-- For "find all summaries that cover memory X"
CREATE INDEX IF NOT EXISTS idx_memories_summarizes_gin
  ON memories USING GIN (summarizes)
  WHERE summary_level > 0;

-- Lineage edge type for summaries (extends existing provenance graph)
-- We reuse provenance_edges with edge_type='summarized_into' (no schema change).
