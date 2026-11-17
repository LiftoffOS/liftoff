-- Add PKCE support for OAuth flows
-- PKCE (Proof Key for Code Exchange) is required for some OAuth providers like HubSpot MCP Auth Apps

-- Add code_verifier column to store the PKCE verifier during OAuth flow
-- The verifier is generated at start and used during token exchange
ALTER TABLE connector_oauth_states ADD COLUMN code_verifier VARCHAR(128);

-- Add comment explaining the column
COMMENT ON COLUMN connector_oauth_states.code_verifier IS 'PKCE code verifier for providers that require it (e.g., HubSpot). Generated at OAuth start, used during token exchange.';
