-- Migration 262: Per-tenant gate for the optional cross-encoder reranker.
--
-- Default false: the reranker (src/memory/rerank.ts) is opt-in per
-- tenant, gated on the offline eval harness (src/scripts/memory-eval/)
-- showing measurable lift against that tenant's data. Global kill via
-- env var MEM_RERANKER_ENABLED=0 takes precedence.

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS memory_reranker_enabled BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN tenants.memory_reranker_enabled IS
  'When true AND MEM_RERANKER_ENABLED=1, retrieveMemoriesVectorSearch reranks top N candidates via the BGE-v2-m3 cross-encoder service. Per-tenant gate; default false.';
