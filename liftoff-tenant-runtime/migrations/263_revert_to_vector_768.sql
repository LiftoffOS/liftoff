-- Migration 263: revert migration 259's halfvec(3072) cascade back to
-- vector(768) on every embedding-bearing table.
--
-- Why: Vertex AI's gemini-embedding-001 rejects outputDimensionality=3072.
-- The error is unambiguous:
--
--   "outputDimensionality value of 3072 but the supported range is from
--    1 (inclusive) to 769 (exclusive)"
--
-- Verified against the live Vertex endpoint. The model's max
-- requestable output dim via the embeddings.create API is 768. Migration
-- 259 and the embedding-config switch to nativeDim=3072
-- were based on a docs-page-vs-API-limit discrepancy — the docs describe
-- a 3072-dim model internally, but the API does not let you request 3072
-- as outputDimensionality. Under 259 every embedding write fails with
-- HTTP 400 INVALID_ARGUMENT and the row is inserted with NULL.
--
-- pgvector cannot ALTER a halfvec column to vector while indexed — drop
-- HNSW indexes first, NULL embeddings (data is stale anyway from the
-- failed-write window), swap the type, recreate indexes empty. The
-- skill-embedding-sweeper + the generalized embedding-backfill worker
-- re-embed asynchronously after deploy.
--
-- embedding_cache is wiped (TRUNCATE) — cached (model, dim) pairs from
-- the 3072d window are stale by definition.

BEGIN;

-- Step 1: Drop HNSW indexes (cannot ALTER column type while indexed).
DROP INDEX IF EXISTS idx_memories_embedding;
DROP INDEX IF EXISTS idx_agent_skills_hnsw;
DROP INDEX IF EXISTS idx_connector_content_embedding;

-- Step 2: NULL all embeddings — these are either NULL already (failed
-- writes from the 3072-broken window) or stale (no embedding succeeded
-- post-259).
UPDATE memories          SET embedding = NULL, embedding_model = NULL WHERE embedding IS NOT NULL;
UPDATE agent_skills      SET embedding = NULL, embedding_model = NULL WHERE embedding IS NOT NULL;
UPDATE connector_content SET embedding = NULL                         WHERE embedding IS NOT NULL;

-- Step 3: Wipe embedding_cache.
TRUNCATE embedding_cache;

-- Step 4: Swap column type halfvec(3072) → vector(768).
ALTER TABLE memories          ALTER COLUMN embedding TYPE vector(768);
ALTER TABLE agent_skills      ALTER COLUMN embedding TYPE vector(768);
ALTER TABLE connector_content ALTER COLUMN embedding TYPE vector(768);

-- Step 5: Recreate HNSW indexes with vector_cosine_ops.
CREATE INDEX idx_memories_embedding
  ON memories USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX idx_agent_skills_hnsw
  ON agent_skills USING hnsw (embedding vector_cosine_ops)
  WHERE status = 'active';

CREATE INDEX idx_connector_content_embedding
  ON connector_content USING hnsw (embedding vector_cosine_ops);

COMMIT;
