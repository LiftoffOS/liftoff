-- Migration 105: OAuth Dynamic Client Registrations
-- Supports RFC 7591 Dynamic Client Registration for providers that use OAuth discovery
-- (e.g., Notion MCP server at mcp.notion.com).
--
-- Unlike existing connectors which use pre-registered static client credentials from
-- environment variables, discovery-based providers obtain a client_id programmatically
-- via .well-known endpoints and dynamic registration. This table stores the platform-level
-- registration data (one row per provider, shared across all tenants).

CREATE TABLE IF NOT EXISTS oauth_dynamic_registrations (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    provider VARCHAR(50) NOT NULL UNIQUE,
    client_id TEXT NOT NULL,
    authorization_endpoint TEXT NOT NULL,
    token_endpoint TEXT NOT NULL,
    registration_endpoint TEXT NOT NULL,
    redirect_uri TEXT NOT NULL,
    metadata JSONB NOT NULL DEFAULT '{}',
    created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW(),
    updated_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Auto-update updated_at on row modification
CREATE TRIGGER update_oauth_dynamic_registrations_updated_at
    BEFORE UPDATE ON oauth_dynamic_registrations
    FOR EACH ROW
    EXECUTE FUNCTION update_updated_at_column();

-- Index for fast provider lookup (UNIQUE constraint already creates an index,
-- but being explicit for documentation)
CREATE INDEX IF NOT EXISTS idx_oauth_dynamic_registrations_provider
    ON oauth_dynamic_registrations(provider);
