CREATE TABLE connector_content (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  connector_type TEXT NOT NULL,
  entity_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  agent_id UUID,
  chunk_index INTEGER NOT NULL DEFAULT 0,
  content TEXT NOT NULL CHECK (length(content) <= 10000),
  content_hash TEXT NOT NULL,
  embedding VECTOR(768),
  content_tsv TSVECTOR GENERATED ALWAYS AS (to_tsvector('simple', content)) STORED,
  tags TEXT[] DEFAULT '{}',
  source TEXT NOT NULL DEFAULT 'tool_call',
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '30 days',
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_connector_content_embedding ON connector_content
  USING hnsw (embedding vector_cosine_ops) WITH (m = 16, ef_construction = 64);
CREATE INDEX idx_connector_content_tsv ON connector_content USING GIN (content_tsv);
CREATE INDEX idx_connector_content_tenant_expires ON connector_content (tenant_id, expires_at);
CREATE INDEX idx_connector_content_connector ON connector_content (tenant_id, connector_type);
CREATE UNIQUE INDEX idx_connector_content_idempotent ON connector_content
  (tenant_id, connector_type, entity_id, chunk_index);
