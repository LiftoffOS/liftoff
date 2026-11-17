-- Migration 258: Align agent_skills.embedding dimension with the platform's
-- actual embedding provider.
--
-- agent_skills (migration 106) was created with embedding vector(1536) when
-- OpenAI text-embedding-3-small was the platform default. The platform has
-- since shifted the embedding default to Google gemini-embedding-001 at 768
-- dimensions (see src/memory/embedding.ts EMBEDDING_CONFIGS, and the prior
-- analogous migration 080 which made the same change for the `memories`
-- table).
--
-- Until now, every skill INSERT has been silently storing NULL embedding
-- because pgvector rejects a 768d vector into a 1536d column ("expected
-- 1536 dimensions, not 768"). The write-time code at
-- src/instruction-compiler/internal-agent-instruction-service.ts swallowed
-- the error and INSERTed with NULL.
--
-- Downstream effect: skill retrieval (src/skills/retrieval.ts) requires
-- embedding IS NOT NULL, so the retrieval query returns empty for every
-- agent, which means injectedSkillIds stays empty, which means the
-- skill-feedback callback to platform-backend never fires, which means
-- reflection-engine never accumulates evidence and the entire learning
-- loop is silent.
--
-- Pattern follows migration 080 (the same fix applied to `memories`).
--
-- After this migration, the skill-embedding-sweeper (cron + one-shot
-- backfill script) will populate the 768d embeddings on existing NULL rows.

BEGIN;

-- Step 1: Drop HNSW index (cannot ALTER column type while indexed).
DROP INDEX IF EXISTS idx_agent_skills_hnsw;

-- Step 2: NULL out any existing embeddings (defensive for any tenant that
-- might have a stray 1536d row from an earlier provider config).
UPDATE agent_skills SET embedding = NULL, embedding_model = NULL
  WHERE embedding IS NOT NULL;

-- Step 3: Change column dimension to 768.
ALTER TABLE agent_skills ALTER COLUMN embedding TYPE vector(768);

-- Step 4: Recreate HNSW index with same shape as migration 106.
CREATE INDEX idx_agent_skills_hnsw ON agent_skills USING hnsw (embedding vector_cosine_ops)
  WHERE status = 'active';

COMMIT;
