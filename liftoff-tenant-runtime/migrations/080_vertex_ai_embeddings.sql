-- Migration 080: Switch embedding provider from OpenAI text-embedding-3-small (1536d)
-- to Vertex AI text-embedding-004 (768d).
--
-- pgvector enforces strict dimension matching: a 768-dim vector cannot be inserted
-- into a vector(1536) column. We must:
-- 1. Drop the HNSW index (cannot ALTER column type with index present)
-- 2. NULL out all existing embeddings (incompatible dimensions)
-- 3. Change the column type from vector(1536) to vector(768)
-- 4. Recreate the HNSW index
-- 5. Update the embedding_model default
--
-- Existing memories will be re-embedded on next save or consolidation cycle.
-- The recency fallback handles missing embeddings gracefully.

BEGIN;

-- Step 1: Drop the HNSW index
DROP INDEX IF EXISTS idx_memories_embedding;

-- Step 2: NULL out all existing embeddings (1536-dim, incompatible with 768-dim column)
UPDATE memories SET embedding = NULL, embedding_model = NULL WHERE embedding IS NOT NULL;

-- Step 3: Change column dimension
ALTER TABLE memories ALTER COLUMN embedding TYPE vector(768);

-- Step 4: Recreate HNSW index with same parameters
CREATE INDEX idx_memories_embedding
  ON memories USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Step 5: Update default embedding_model for new rows
ALTER TABLE memories ALTER COLUMN embedding_model SET DEFAULT 'text-embedding-004';

COMMIT;
