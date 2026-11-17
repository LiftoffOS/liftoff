// Custom MCP Server types.
//
// A custom MCP server is a tools-only MCP endpoint registered by the
// tenant. It is paired 1:1 with a connectors row (connector_type =
// 'custom_mcp_server') so internal agents bind to it through the existing
// IntegrationPermission[] model. The endpoint may be a public URL the
// tenant owns or a tunnel-routed *.tunnels.example.com URL.

import type { AuthType, CustomHeader, MCPToolDefinition } from '../mcp/types';

export type CustomMcpServerDeliveryMode = 'public_url' | 'tunneled';

export interface CustomMcpServer {
  id: string;
  tenantId: string;
  name: string;
  deliveryMode: CustomMcpServerDeliveryMode;
  /** The URL tenant-runtime calls. For tunneled mode, this is the route's public_url. */
  endpointUrl: string;
  authType: AuthType;
  /** Secret Manager reference when authType !== 'none'. */
  authSecretName: string | null;
  /** Required for tunneled mode; null for public_url mode. */
  tunnelRouteId: string | null;
  rawMcpTools: MCPToolDefinition[];
  /** Paired connectors row (always present). */
  connectorId: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateCustomMcpServerInput {
  name: string;
  deliveryMode: CustomMcpServerDeliveryMode;
  /** Required for public_url mode; ignored for tunneled mode (resolved from tunnelRouteId). */
  endpointUrl?: string;
  authType: AuthType;
  apiKey?: string;
  bearerToken?: string;
  customHeaders?: CustomHeader[];
  /** Required for tunneled mode; rejected for public_url mode. */
  tunnelRouteId?: string;
}

/**
 * Everything about a customer-hosted MCP server that can change without it
 * becoming a different server.
 *
 * `name` used to be the only field, which made a server whose endpoint moved
 * or whose token rotated unrepairable: the only remedy was delete and
 * recreate, and delete takes the connector id with it, so every agent bound
 * to that server had to be re-bound by hand. Editing in place keeps the
 * connector id, so every bound team recovers at once — the same property that
 * makes an OAuth reconnect work.
 *
 * `deliveryMode` is deliberately absent. Moving between a public URL and a
 * tunnel changes how the row is provisioned (tunnel route allocation, a
 * different endpoint source of truth), which is a different server, not an
 * edit to this one.
 */
export interface UpdateCustomMcpServerInput {
  name?: string;
  /** Only meaningful for public_url servers; a tunnel owns its own endpoint. */
  endpointUrl?: string;
  /** Changing this replaces the stored credential; see the secret rules on update(). */
  authType?: AuthType;
  apiKey?: string;
  bearerToken?: string;
  customHeaders?: CustomHeader[];
}
