-- AI Team configuration versioning
-- Tracks full history of all configuration changes for rollback and audit

CREATE TABLE ai_team_versions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  ai_team_id UUID NOT NULL REFERENCES ai_teams(id) ON DELETE CASCADE,
  version INT NOT NULL,

  -- Snapshot of all configurable fields
  role VARCHAR(255) NOT NULL,
  responsibilities TEXT,
  integrations JSONB NOT NULL DEFAULT '[]',
  additional_context TEXT,
  system_prompt TEXT,
  user_instructions TEXT,

  -- Metadata
  source VARCHAR(20) NOT NULL CHECK (source IN ('create', 'distill', 'manual')),
  created_by UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  UNIQUE(ai_team_id, version)
);

-- Index for efficient version lookups
CREATE INDEX idx_ai_team_versions_team ON ai_team_versions(ai_team_id);
CREATE INDEX idx_ai_team_versions_team_latest ON ai_team_versions(ai_team_id, version DESC);

-- Add current_version column to ai_teams for quick access
ALTER TABLE ai_teams ADD COLUMN current_version INT NOT NULL DEFAULT 1;

COMMENT ON TABLE ai_team_versions IS 'Stores versioned snapshots of AI team configuration. Every change to role, responsibilities, integrations, additionalContext, systemPrompt, or userInstructions creates a new version.';
COMMENT ON COLUMN ai_team_versions.source IS 'How this version was created: create (initial), distill (LLM-generated), manual (user edit)';
