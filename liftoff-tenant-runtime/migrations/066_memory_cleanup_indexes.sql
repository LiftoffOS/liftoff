-- Indexes for efficient memory garbage collection queries
CREATE INDEX IF NOT EXISTS idx_memories_expires_at
  ON memories(tenant_id, expires_at)
  WHERE expires_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_memories_superseded
  ON memories(tenant_id, superseded_at)
  WHERE superseded_at IS NOT NULL;
