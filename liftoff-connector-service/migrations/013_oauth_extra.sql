-- Adds an `extra` JSONB column to connector_oauth_states. Used by the
-- Composio-managed OAuth branch to round-trip the connection request id
-- and auth config id between /start and /callback. Optional for every
-- other branch.
ALTER TABLE connector_oauth_states ADD COLUMN IF NOT EXISTS extra JSONB;
