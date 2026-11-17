-- Create reflection_pattern_weights table referenced by service code
-- (updatePatternWeight at repository.ts line 283 expects this table)
CREATE TABLE IF NOT EXISTS reflection_pattern_weights (
  agent_id UUID NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  pattern TEXT NOT NULL,
  evidence_types TEXT[],
  weight DECIMAL NOT NULL DEFAULT 0.5,
  sample_count INT NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (agent_id, pattern)
);
