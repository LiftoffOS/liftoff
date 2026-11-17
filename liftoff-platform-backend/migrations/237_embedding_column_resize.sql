-- Phase 2.2: Add new vector(768) columns alongside the existing vector(1536)
-- columns. Worker populates v2; retrieval reads v1 until KNOWLEDGE_EMBEDDING_V2_READ
-- is flipped, then a follow-up migration drops v1. This avoids any read-side
-- downtime during the multi-hour backfill.

ALTER TABLE knowledge_items ADD COLUMN embedding_v2 vector(768);
CREATE INDEX knowledge_items_embedding_v2_idx
  ON knowledge_items USING hnsw (embedding_v2 vector_cosine_ops);

ALTER TABLE internal_agents ADD COLUMN capability_embedding_v2 vector(768);
CREATE INDEX internal_agents_capability_embedding_v2_idx
  ON internal_agents USING hnsw (capability_embedding_v2 vector_cosine_ops);

-- Extend the invalidation trigger to wipe BOTH columns when extracted_text
-- changes. Once the v1 column is dropped, the follow-up migration simplifies
-- this back to just embedding_v2.
CREATE OR REPLACE FUNCTION knowledge_items_invalidate_embedding()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.extracted_text IS DISTINCT FROM OLD.extracted_text THEN
    IF NEW.embedding    IS NOT DISTINCT FROM OLD.embedding    THEN NEW.embedding    := NULL; END IF;
    IF NEW.embedding_v2 IS NOT DISTINCT FROM OLD.embedding_v2 THEN NEW.embedding_v2 := NULL; END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
