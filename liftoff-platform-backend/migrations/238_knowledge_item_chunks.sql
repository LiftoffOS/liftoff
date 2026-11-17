-- Phase 3.1: per-chunk embeddings.
-- A 50-page SOP averaged into one vector becomes mushy. Storing each chunk
-- with its own embedding lets corpus_search match the specific paragraph
-- and return it as the excerpt.

CREATE TABLE knowledge_item_chunks (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  item_id       UUID NOT NULL REFERENCES knowledge_items(id) ON DELETE CASCADE,
  tenant_id     TEXT NOT NULL,
  chunk_index   INTEGER NOT NULL,
  text          TEXT NOT NULL,
  embedding     vector(768),
  -- Provider + model the chunk's embedding was produced by. Required so a
  -- mid-corpus provider switch (operator changes EMBEDDING_PROVIDER) doesn't
  -- mix semantic spaces in the same retrieval window. Retrieval filters to
  -- the current provider+model and treats other chunks as stale (worker
  -- re-embeds them on next sweep, gated by a `WHERE provider != current OR
  -- model != current` clause in findPendingForChunkEmbedding).
  embedding_provider TEXT NOT NULL,
  embedding_model    TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (item_id, chunk_index)
);

CREATE INDEX knowledge_item_chunks_embedding_idx
  ON knowledge_item_chunks USING hnsw (embedding vector_cosine_ops);

CREATE INDEX knowledge_item_chunks_tenant_id_idx
  ON knowledge_item_chunks (tenant_id);

-- Partial index supports the "find stale chunks under current provider"
-- query that drives the re-embed worker after a provider switch.
CREATE INDEX knowledge_item_chunks_provider_model_idx
  ON knowledge_item_chunks (embedding_provider, embedding_model);

ALTER TABLE knowledge_item_chunks ENABLE ROW LEVEL SECURITY;
CREATE POLICY knowledge_item_chunks_tenant_isolation
  ON knowledge_item_chunks
  USING (tenant_id = current_setting('app.tenant_id'));

-- Patch trigger to wipe per-chunk rows AND BOTH per-item embedding columns
-- on extracted_text edits. The chunks delete is new (Phase 3); the per-item
-- NULLs preserve the dual-write invalidation from migration 237 so the
-- Phase 2 read path keeps working during the chunks rollout window.
CREATE OR REPLACE FUNCTION knowledge_items_invalidate_embedding()
RETURNS TRIGGER AS $$
BEGIN
  IF NEW.extracted_text IS DISTINCT FROM OLD.extracted_text THEN
    IF NEW.embedding    IS NOT DISTINCT FROM OLD.embedding    THEN NEW.embedding    := NULL; END IF;
    IF NEW.embedding_v2 IS NOT DISTINCT FROM OLD.embedding_v2 THEN NEW.embedding_v2 := NULL; END IF;
    DELETE FROM knowledge_item_chunks WHERE item_id = NEW.id;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
