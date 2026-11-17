// Tunnels module types.
//
// Tunnel infrastructure is a peer of consumers (custom_mcp_servers,
// external_agents) — not nested inside them. A single tunnel deployment
// can host many routes; each route is referenced by at most one consumer.

export type TunnelStatus = 'pending' | 'active' | 'disconnected';

export interface TunnelDeployment {
  id: string;
  tenantId: string;
  name: string;
  tenantPrefix: string;
  /** Reference into Secret Manager. The plaintext token is never returned by the API after creation. */
  tunnelTokenSecretName: string;
  /** Stub flag for the future SNI-passthrough mode. Always false in MVP. */
  innerTlsEnabled: boolean;
  status: TunnelStatus;
  lastSeenAt: Date | null;
  /**
   * In-container loopback TCP port (20000–29999) assigned at deployment
   * creation. The customer's chisel client opens `R:<port>:upstream-host:port`
   * when it connects; the tunnel-service dispatcher then dials
   * `localhost:<port>` to forward HTTP traffic. See migration 229.
   */
  loopbackPort: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface TunnelRoute {
  id: string;
  deploymentId: string;
  subdomain: string;
  /** Upstream URL inside the customer's network — never reachable by Liftoff directly. */
  upstreamUrl: string;
  /** Derived "https://{tenant_prefix}-{subdomain}.{TUNNEL_BASE_DOMAIN}". */
  publicUrl: string;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateTunnelDeploymentInput {
  tenantId: string;
  name: string;
  /** Auto-derived from tenant slug when omitted; must be globally unique. */
  tenantPrefix?: string;
}

/** The plaintext token is included exactly once in the create response — never again. */
export interface CreateTunnelDeploymentResult {
  deployment: TunnelDeployment;
  /** One-shot plaintext tunnel token. Shown to the customer inside the `docker run` command. */
  tunnelToken: string;
  /** Templated docker-run / docker-compose snippet for the customer to copy. */
  deployArtifact: TunnelDeployArtifact;
}

export interface TunnelDeployArtifact {
  /** Pinned image tag (no :latest). */
  image: string;
  /** Ready-to-paste docker run command line. */
  dockerRunCommand: string;
  /** Ready-to-paste docker-compose.yml snippet. */
  dockerComposeYaml: string;
  /** Terminator hostname the chisel client connects to. */
  terminatorEndpoint: string;
}

export interface CreateTunnelRouteInput {
  deploymentId: string;
  upstreamUrl: string;
}

export interface RotateTunnelTokenResult {
  /** One-shot plaintext new token. The previous token continues to validate for a 5-minute grace window. */
  newTunnelToken: string;
  /** When the prior token version stops validating. */
  previousTokenExpiresAt: Date;
}
