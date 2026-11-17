-- Semantic recall (v2): per-turn embedding + the provider/model that
-- produced it (m238 precedent — vectors from different providers/models are
-- different spaces and must never be compared). All three set together;
-- NULL vector = not yet embedded (guest turns stay NULL forever).
--
-- Safe on this RLS-FORCED table (294 lesson): ADD COLUMN does no row scan.
-- NO vector index: retrieval filters by (tenant, agent, sender) via
-- idx_turns_recall and exact-sorts the small per-user history. A global
-- HNSW index would post-filter an approximate scan and can miss or empty
-- out results for selective predicates (pgvector documented behavior).
ALTER TABLE agent_chat_turns ADD COLUMN content_embedding vector(768);
ALTER TABLE agent_chat_turns ADD COLUMN content_embedding_provider TEXT;
ALTER TABLE agent_chat_turns ADD COLUMN content_embedding_model TEXT;
