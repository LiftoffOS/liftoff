-- migrations/124_embedding_cache.sql
--
-- IMPORTANT: `memories.embedding` is vector(768) (migration 080 switched
-- from OpenAI 1536-dim to Vertex AI 768-dim). Cache stores the same
-- dim. If we change models again, the embedding_model column lets us
-- invalidate entries by querying `WHERE embedding_model != 'current'`.
-- Using unsized `vector` (no dim constraint) so future model swaps don't
-- require re-creating this table.

CREATE TABLE IF NOT EXISTS embedding_cache (
  content_hash    TEXT         NOT NULL,
  embedding_model TEXT         NOT NULL,
  embedding       vector       NOT NULL,
  created_at      TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  last_used_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
  hit_count       INTEGER      NOT NULL DEFAULT 0,
  PRIMARY KEY (content_hash, embedding_model)
);

CREATE INDEX IF NOT EXISTS idx_embedding_cache_last_used ON embedding_cache(last_used_at);
