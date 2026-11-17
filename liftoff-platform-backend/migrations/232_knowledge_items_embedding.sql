-- Hybrid retrieval for corpus_search: layers vector similarity on top of the
-- tsvector full-text index added in migration 230. Matches the embedding
-- provider/dimensionality already used by internal_agents.capability_embedding:
-- OpenAI text-embedding-3-small (1536 dims) via getOpenAIApiKeyForGroup.

CREATE EXTENSION IF NOT EXISTS vector;

ALTER TABLE knowledge_items ADD COLUMN embedding vector(1536);

CREATE INDEX knowledge_items_embedding_idx
  ON knowledge_items USING hnsw (embedding vector_cosine_ops);

-- Invalidate the stored vector whenever the source text changes. The
-- background worker (jobs/embed-knowledge-content.ts) re-embeds any row
-- with embedding IS NULL on its next sweep. Keeping the invalidation in
-- the database (rather than the saveExtractedText caller) means:
--   1) Phase 1 extraction code stays decoupled from Phase 3 — if this
--      migration is rolled back, extraction continues to work.
--   2) Any future writer of extracted_text gets the right behaviour for
--      free; no one can forget to null the vector.
-- Guarded so a co-write (UPDATE ... SET extracted_text = X, embedding = Y)
-- is respected: the trigger only fires when the new embedding is NULL,
-- which is the default-NULL case from saveExtractedText.
CREATE OR REPLACE FUNCTION knowledge_items_invalidate_embedding()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.extracted_text IS DISTINCT FROM OLD.extracted_text
     AND NEW.embedding IS NOT DISTINCT FROM OLD.embedding THEN
    NEW.embedding := NULL;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER knowledge_items_invalidate_embedding_trg
  BEFORE UPDATE OF extracted_text ON knowledge_items
  FOR EACH ROW
  EXECUTE FUNCTION knowledge_items_invalidate_embedding();
