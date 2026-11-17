-- Memory usefulness tracking, importance scoring, quarantine, and graduation state.
-- DDL only — no data backfill (that's in 072b).

ALTER TABLE memories ADD COLUMN IF NOT EXISTS usefulness_score INTEGER NOT NULL DEFAULT 0
  CHECK (usefulness_score BETWEEN -10 AND 100);
ALTER TABLE memories ADD COLUMN IF NOT EXISTS usefulness_last_updated TIMESTAMPTZ;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS retrievable_after TIMESTAMPTZ;
ALTER TABLE memories ADD COLUMN IF NOT EXISTS importance_score SMALLINT NOT NULL DEFAULT 3
  CHECK (importance_score BETWEEN 1 AND 5);
ALTER TABLE memories ADD COLUMN IF NOT EXISTS graduated_at TIMESTAMPTZ;

-- Usefulness-based queries (consolidation graduation criteria)
CREATE INDEX IF NOT EXISTS idx_memories_usefulness
  ON memories(tenant_id, agent_id, usefulness_score)
  WHERE superseded_by IS NULL;

-- Composite index for cold-start execution count check (LIMIT 6 optimization)
CREATE INDEX IF NOT EXISTS idx_invocations_tenant_agent
  ON invocations(tenant_id, agent_id);

-- GIN index for tag-based queries in consolidation
CREATE INDEX IF NOT EXISTS idx_memories_tags
  ON memories USING gin(tags)
  WHERE superseded_by IS NULL;

-- Partial index for consolidation per-agent fetch
CREATE INDEX IF NOT EXISTS idx_memories_agent_active
  ON memories(agent_id)
  WHERE superseded_by IS NULL;
