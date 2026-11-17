-- Private MCP & Agent Tunnels — Phase 1 schema.
--
-- Adds the shared tunnel infrastructure (mcp_tunnel_deployments,
-- mcp_tunnel_routes), the Custom MCP Server consumer (custom_mcp_servers,
-- paired 1:1 with a connectors row), and a nullable tunnel_route_id FK on
-- external_agents so the existing External Collaborator flow can opt into
-- tunneled delivery.

-- The customer-side Docker deployment. One per "physical tunnel container".
CREATE TABLE mcp_tunnel_deployments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  tenant_prefix VARCHAR(63) NOT NULL,
  tunnel_token_secret_name TEXT NOT NULL,
  inner_tls_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  status VARCHAR(20) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'active', 'disconnected', 'error')),
  last_seen_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(tenant_prefix)
);

-- Each upstream the tunnel exposes.
CREATE TABLE mcp_tunnel_routes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  deployment_id UUID NOT NULL REFERENCES mcp_tunnel_deployments(id) ON DELETE CASCADE,
  subdomain VARCHAR(63) NOT NULL,
  upstream_url TEXT NOT NULL,
  public_url TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(deployment_id, subdomain)
);

-- Consumer A: tools-only MCP server registration.
CREATE TABLE custom_mcp_servers (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id UUID NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  name VARCHAR(255) NOT NULL,
  delivery_mode VARCHAR(20) NOT NULL CHECK (delivery_mode IN ('public_url', 'tunneled')),
  endpoint_url TEXT NOT NULL,
  auth_type VARCHAR(20) NOT NULL DEFAULT 'none'
    CHECK (auth_type IN ('none', 'api_key', 'bearer_token', 'custom_headers')),
  auth_secret_name TEXT,
  tunnel_route_id UUID REFERENCES mcp_tunnel_routes(id) ON DELETE SET NULL,
  raw_mcp_tools JSONB NOT NULL DEFAULT '[]'::jsonb,
  connector_id UUID NOT NULL REFERENCES connectors(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (
    (delivery_mode = 'public_url' AND tunnel_route_id IS NULL)
    OR
    (delivery_mode = 'tunneled' AND tunnel_route_id IS NOT NULL)
  )
);

CREATE INDEX idx_mcp_tunnel_deployments_tenant ON mcp_tunnel_deployments(tenant_id);
CREATE INDEX idx_mcp_tunnel_routes_deployment ON mcp_tunnel_routes(deployment_id);
CREATE INDEX idx_custom_mcp_servers_tenant ON custom_mcp_servers(tenant_id);
CREATE INDEX idx_custom_mcp_servers_connector ON custom_mcp_servers(connector_id);
CREATE INDEX idx_custom_mcp_servers_route ON custom_mcp_servers(tunnel_route_id);

-- Consumer B: existing external_agents table gains a nullable FK.
ALTER TABLE external_agents
  ADD COLUMN tunnel_route_id UUID REFERENCES mcp_tunnel_routes(id) ON DELETE SET NULL;
CREATE INDEX idx_external_agents_tunnel_route ON external_agents(tunnel_route_id);
