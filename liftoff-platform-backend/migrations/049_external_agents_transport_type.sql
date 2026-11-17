-- Add transport_type column to external_agents
-- Stores the detected MCP transport type for runtime use
-- Values: 'streamable-http' (current standard) or 'sse' (legacy, used by Cloudflare)

ALTER TABLE external_agents
ADD COLUMN transport_type VARCHAR(20) NOT NULL DEFAULT 'streamable-http'
CHECK (transport_type IN ('streamable-http', 'sse'));

-- Comment for documentation
COMMENT ON COLUMN external_agents.transport_type IS
    'MCP transport protocol: streamable-http (current standard) or sse (legacy HTTP+SSE)';
