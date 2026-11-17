-- Add has_created_ai_team flag to tenants table
-- This tracks whether any AI team has ever been created in the workspace
-- Used for onboarding UX ("First Team" vs "New Team")

ALTER TABLE tenants ADD COLUMN IF NOT EXISTS has_created_ai_team BOOLEAN NOT NULL DEFAULT FALSE;

-- Backfill: Set to true for tenants that already have AI teams
UPDATE tenants SET has_created_ai_team = TRUE
WHERE id IN (SELECT DISTINCT tenant_id FROM ai_teams);
