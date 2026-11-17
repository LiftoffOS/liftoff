-- Add JSONB column for recently viewed teams
-- Structure: { "tenant_id": [{ teamId, viewedAt, source }] }
ALTER TABLE accounts
ADD COLUMN IF NOT EXISTS recently_viewed_teams JSONB DEFAULT '{}';
