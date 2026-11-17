-- Migration: Rename ai_team_summary column to summary
-- This column was missed in migration 055_rename_ai_team_to_internal_agent.sql

ALTER TABLE internal_agents RENAME COLUMN ai_team_summary TO summary;
