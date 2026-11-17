-- AI Teams Distill Columns
-- Adds columns for LLM-generated content

ALTER TABLE ai_teams
ADD COLUMN ai_team_summary TEXT,
ADD COLUMN system_prompt TEXT,
ADD COLUMN user_instructions TEXT;
