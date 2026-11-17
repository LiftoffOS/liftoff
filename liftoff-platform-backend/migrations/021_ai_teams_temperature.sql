-- Add temperature column to ai_teams for LLM configuration
ALTER TABLE ai_teams
ADD COLUMN temperature DECIMAL(3, 2) DEFAULT 0.3;

-- Set default for existing rows
UPDATE ai_teams SET temperature = 0.3 WHERE temperature IS NULL;
