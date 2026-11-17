-- Agent Skills
-- Stores discrete, semantically-selectable instruction modules for each agent.
-- Skills replace the monolithic user_instructions blob: at execution time, only
-- the top-K skills relevant to the current objective are injected into the prompt.
--
-- Embedding is generated against skill.description (the semantic anchor for retrieval),
-- not the full instruction text. This keeps the vector focused on relevance signal.

CREATE TABLE agent_skills (
  id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id                UUID NOT NULL,
  agent_id                 UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  compiled_instruction_id  UUID REFERENCES compiled_instructions(id),
  name                     TEXT NOT NULL,
  description              TEXT NOT NULL,
  instruction              TEXT NOT NULL,
  embedding                VECTOR(1536),
  embedding_model          TEXT,
  tags                     TEXT[] DEFAULT '{}',
  usefulness_score         INTEGER NOT NULL DEFAULT 0,
  status                   TEXT NOT NULL DEFAULT 'active'
                             CHECK (status IN ('active', 'superseded')),
  created_at               TIMESTAMPTZ DEFAULT NOW(),
  updated_at               TIMESTAMPTZ DEFAULT NOW()
);

CREATE INDEX idx_agent_skills_agent   ON agent_skills (agent_id, status) WHERE status = 'active';
CREATE INDEX idx_agent_skills_hnsw    ON agent_skills USING hnsw (embedding vector_cosine_ops)
  WHERE status = 'active';
CREATE INDEX idx_agent_skills_tenant  ON agent_skills (tenant_id, agent_id);
