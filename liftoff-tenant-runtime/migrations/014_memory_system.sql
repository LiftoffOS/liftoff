-- Memory System
-- Memory System

-- Enable pgvector extension for semantic search
CREATE EXTENSION IF NOT EXISTS vector;

CREATE TABLE memories (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    -- [FIX: BE-001] Add FK constraint to tenants
    tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
    layer TEXT NOT NULL CHECK (layer IN ('global', 'role', 'individual')),
    scope_key TEXT NOT NULL CHECK (length(scope_key) <= 255 AND scope_key ~ '^[a-zA-Z0-9_-]+$'),
    agent_id UUID REFERENCES agents(id) ON DELETE SET NULL,
    workflow_id UUID REFERENCES workflows(id) ON DELETE SET NULL,
    -- [FIX: SE-004] Content size limit
    content TEXT NOT NULL CHECK (length(content) <= 102400), -- 100KB max
    -- [FIX: DE-001] Content hash for idempotency
    content_hash TEXT NOT NULL,
    embedding vector(1536),
    -- [FIX: DE-010] Track embedding model for lineage
    embedding_model TEXT DEFAULT 'text-embedding-3-small',
    -- [FIX: SE-004] Validate tags
    tags TEXT[] DEFAULT '{}' CHECK (array_length(tags, 1) IS NULL OR array_length(tags, 1) <= 20),
    -- [FIX: DE-003] Content classification for PII handling
    content_classification TEXT NOT NULL DEFAULT 'internal'
      CHECK (content_classification IN ('public', 'internal', 'pii', 'sensitive')),
    expires_at TIMESTAMP WITH TIME ZONE,
    -- [FIX: SE-007/BE-009] Supersession with circular ref protection
    superseded_by UUID REFERENCES memories(id) ON DELETE SET NULL
      CHECK (superseded_by IS NULL OR superseded_by != id),
    superseded_at TIMESTAMP WITH TIME ZONE,
    supersession_reason TEXT,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- [FIX: DE-001] Unique constraint for idempotency
CREATE UNIQUE INDEX idx_memories_idempotent
  ON memories(tenant_id, layer, scope_key, content_hash)
  WHERE superseded_by IS NULL;

-- [FIX: BE-002] Indexes on FK columns
CREATE INDEX idx_memories_tenant ON memories(tenant_id);
CREATE INDEX idx_memories_agent ON memories(agent_id);
CREATE INDEX idx_memories_workflow ON memories(workflow_id);
CREATE INDEX idx_memories_layer_scope ON memories(tenant_id, layer, scope_key);
CREATE INDEX idx_memories_created ON memories(tenant_id, created_at DESC);

-- [FIX: BE-009] Partial index for current (non-superseded) memories
CREATE INDEX idx_memories_current
  ON memories(tenant_id, layer, scope_key)
  WHERE superseded_by IS NULL;

-- [FIX: BE-003/DE-006] Use HNSW index (works with small/empty datasets)
-- Note: Create AFTER initial data load for best performance
-- For empty tables, HNSW handles gracefully unlike IVFFlat
CREATE INDEX idx_memories_embedding
  ON memories USING hnsw (embedding vector_cosine_ops)
  WITH (m = 16, ef_construction = 64);

-- Auto-update trigger
CREATE TRIGGER update_memories_updated_at
    BEFORE UPDATE ON memories
    FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

COMMENT ON TABLE memories IS 'Semantic memory storage for agents with layered access control and vector search.';
COMMENT ON COLUMN memories.layer IS 'global=tenant-wide, role=per-role, individual=per-agent';
COMMENT ON COLUMN memories.scope_key IS 'Identifier within layer (e.g., agent_id for individual layer)';
COMMENT ON COLUMN memories.content_classification IS 'public=no restrictions, internal=tenant-only, pii=encrypted+logged, sensitive=encrypted+admin-only';
COMMENT ON COLUMN memories.embedding IS '1536-dimensional vector from text-embedding-3-small';
