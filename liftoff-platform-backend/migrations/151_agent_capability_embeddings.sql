-- Agent capability embeddings for semantic find_teammates search.
-- Replaces ILIKE substring matching with cosine similarity so queries like
-- "find an agent that handles contract review with Salesforce access" return
-- semantically relevant results rather than requiring exact keyword matches.
--
-- Vector dimension: 1536 — matches text-embedding-3-small output.
-- Index: HNSW with cosine ops for approximate nearest-neighbor search.
--        m=16, ef_construction=64 are sensible defaults for up to ~100k rows.
--        Can be tuned later if recall degrades at scale.
--
-- Backfill: column starts NULL for existing agents. The embedding service
-- generates and stores vectors on next create/distill/update. A one-off
-- Cloud Run job should backfill existing active agents post-deploy.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE internal_agents
  ADD COLUMN IF NOT EXISTS capability_embedding VECTOR(1536);

CREATE INDEX idx_internal_agents_capability_embedding
  ON internal_agents
  USING hnsw (capability_embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64)
  WHERE capability_embedding IS NOT NULL;

COMMENT ON COLUMN internal_agents.capability_embedding IS
  'text-embedding-3-small vector (1536-dim) over role + responsibilities + summary + capabilities. '
  'NULL until first distill/update after migration 151. Used by find_teammates for semantic search.';
