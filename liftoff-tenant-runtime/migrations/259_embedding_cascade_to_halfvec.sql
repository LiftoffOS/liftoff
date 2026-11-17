-- Migration 259: Switch every tenant-runtime embedding column from
-- vector(768) (Matryoshka-truncated Google output) to halfvec(3072),
-- the native dimension of gemini-embedding-001.
--
-- WHY: src/memory/embedding.ts is now the single source of truth for
-- each provider's NATIVE dim. We no longer truncate. The platform
-- default is Google gemini-embedding-001 at 3072d native.
--
-- WHY halfvec: vector(3072) at float32 is 12KB/row vs 3KB for the
-- current vector(768). halfvec(3072) is ~6KB/row — flat with our
-- previous footprint. pgvector docs say <1% precision loss. Requires
-- pgvector 0.8.1 or later on every Cloud SQL instance, so halfvec
-- + halfvec_cosine_ops are available.
--
-- pgvector cannot ALTER a column from vector to halfvec while indexed
-- by HNSW on the original type — we drop indexes, NULL embeddings,
-- swap the type, then recreate indexes empty. PR-3 worker re-embeds
-- asynchronously after the deploy.
--
-- The embedding_cache table is generic 'vector' (mig 199) so it
-- accepts any dim. Cached rows are now stale by definition; TRUNCATE
-- to clean up rather than carry forward mismatched (model, dim) pairs.

BEGIN;

-- Step 1: Drop HNSW indexes (cannot ALTER column type while indexed).
DROP INDEX IF EXISTS idx_memories_embedding;
DROP INDEX IF EXISTS idx_agent_skills_hnsw;
DROP INDEX IF EXISTS idx_connector_content_embedding;

-- Step 2: NULL existing embeddings. The vector space is different
-- (Matryoshka-truncated 768d → native 3072d); the data isn't
-- recoverable in-place. PR-3 worker re-embeds.
UPDATE memories          SET embedding = NULL, embedding_model = NULL WHERE embedding IS NOT NULL;
UPDATE agent_skills      SET embedding = NULL, embedding_model = NULL WHERE embedding IS NOT NULL;
UPDATE connector_content SET embedding = NULL                          WHERE embedding IS NOT NULL;

-- Step 3: Wipe embedding_cache (stale model + dim pairs).
TRUNCATE embedding_cache;

-- Step 4: Swap column type to halfvec(3072).
ALTER TABLE memories          ALTER COLUMN embedding TYPE halfvec(3072);
ALTER TABLE agent_skills      ALTER COLUMN embedding TYPE halfvec(3072);
ALTER TABLE connector_content ALTER COLUMN embedding TYPE halfvec(3072);

-- Step 5: Recreate HNSW indexes with the halfvec operator class.
-- Match the original index shapes (partial filter on agent_skills per
-- migration 258).
CREATE INDEX idx_memories_embedding
  ON memories USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);

CREATE INDEX idx_agent_skills_hnsw
  ON agent_skills USING hnsw (embedding halfvec_cosine_ops)
  WHERE status = 'active';

CREATE INDEX idx_connector_content_embedding
  ON connector_content USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Step 6: Update embedding_model default on memories to the new
-- platform default.
ALTER TABLE memories ALTER COLUMN embedding_model SET DEFAULT 'gemini-embedding-001';

COMMIT;
