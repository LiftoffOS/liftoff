-- Migration 083: Add credential hint to connectors table
-- Stores last 4 chars of API key for UI display (e.g., "•••gC2m")
-- Same pattern as external_agents.api_key_hint (migration 051)
-- Actual credentials remain in Secret Manager — hints are non-sensitive

ALTER TABLE connectors
ADD COLUMN IF NOT EXISTS api_key_hint VARCHAR(10);

COMMENT ON COLUMN connectors.api_key_hint IS 'Last 4 chars of API key for masked UI display (e.g., "•••gC2m"). Non-sensitive.';
