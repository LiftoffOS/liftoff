-- External Agent Health and Credentials (EA-001, EA-002)
-- Adds credential tracking for OAuth token refresh scheduling

-- Track OAuth token expiry for refresh scheduling
CREATE TABLE IF NOT EXISTS external_agent_credentials (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    external_agent_id UUID NOT NULL REFERENCES external_agents(id) ON DELETE CASCADE,
    secret_name TEXT NOT NULL,  -- Full Secret Manager path
    token_expires_at TIMESTAMP WITH TIME ZONE,
    refreshed_at TIMESTAMP WITH TIME ZONE,
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    UNIQUE(external_agent_id)
);

-- Index for finding agents with expiring tokens
CREATE INDEX idx_external_agent_credentials_expiry
    ON external_agent_credentials (token_expires_at)
    WHERE token_expires_at IS NOT NULL;

-- Index for looking up credentials by agent
CREATE INDEX idx_external_agent_credentials_agent
    ON external_agent_credentials (external_agent_id);

-- Add health_check_error column if not exists (for detailed error messages)
-- Note: last_error and last_checked_at already exist from migration 048
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'external_agents' AND column_name = 'health_check_count'
    ) THEN
        ALTER TABLE external_agents ADD COLUMN health_check_count INTEGER NOT NULL DEFAULT 0;
    END IF;
END $$;

-- Track consecutive health check failures for alerting
DO $$
BEGIN
    IF NOT EXISTS (
        SELECT 1 FROM information_schema.columns
        WHERE table_name = 'external_agents' AND column_name = 'consecutive_failures'
    ) THEN
        ALTER TABLE external_agents ADD COLUMN consecutive_failures INTEGER NOT NULL DEFAULT 0;
    END IF;
END $$;
