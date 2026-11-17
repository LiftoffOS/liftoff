-- migrations/126_memories_influence_score.sql

ALTER TABLE memories
  ADD COLUMN IF NOT EXISTS influence_score REAL NOT NULL DEFAULT 0.5
    CHECK (influence_score >= 0 AND influence_score <= 1),
  ADD COLUMN IF NOT EXISTS influence_last_computed TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_memories_influence
  ON memories(tenant_id, influence_score DESC)
  WHERE superseded_by IS NULL;

-- Incremental rollup table — per-day cited/retrieved per memory.
-- Recompute reads only the rollup, not raw events. Cuts full-scan cost.
CREATE TABLE IF NOT EXISTS memory_influence_rollup (
  tenant_id   UUID         NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  memory_id   UUID         NOT NULL,
  day         DATE         NOT NULL,
  retrieved   INTEGER      NOT NULL,
  cited       INTEGER      NOT NULL,
  PRIMARY KEY (tenant_id, memory_id, day)
);

CREATE INDEX IF NOT EXISTS idx_influence_rollup_tenant_day ON memory_influence_rollup(tenant_id, day DESC);
