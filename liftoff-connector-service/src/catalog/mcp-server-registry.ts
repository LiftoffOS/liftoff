// MCP Server Registry
// Maps connectorType → MCP server config.
// Tells the tool gateway which connectors use MCP vs REST.
//
// As of the unified-catalog refactor, `MCP_SERVER_REGISTRY` is a PROJECTION
// of the `CONNECTORS` map in ./connectors.ts (entries with `mcp !== undefined`).
// To add/remove/modify a connector's MCP config, edit its entry in
// connectors.ts — this file derives the runtime shape at module load.
//
// Per-workspace URL resolver functions (Snowflake, Databricks) are looked up
// via `urlResolverKey` into the URL_RESOLVERS map (also in connectors.ts) so
// ConnectorDef remains JSON-serializable for the catalog HTTP endpoint.

import { logger } from '../infra/logging.js';
import { CONNECTORS, URL_RESOLVERS } from './connectors.js';

// URL allowlist for vendor-hosted MCP servers (SE-002)
// Before MCPClient sends credentials, the target URL must match this allowlist.
export const ALLOWED_MCP_DOMAINS = new Set([
  // Vendor-hosted MCP servers
  'mcp.stripe.com',
  'mcp.hubspot.com',
  // GTM / market-intelligence (Change 6 — vendor_hosted + DCR)
  'mcp.zoominfo.com',
  'mcp.commonroom.io',
  'mcp.similarweb.com',
  'api.ahrefs.com',
  'mcp.supermetrics.com',
  'api.outreach.io',
  'api.github.com',
  'api.githubcopilot.com',
  'mcp.github.com',
  'gitlab.com',
  'mcp.notion.com',
  'mcp.intuit.com',
  'mcp.xero.com',
  'mcp.intercom.com',
  'mcp.sentry.dev',
  'mcp.linear.app',
  'mcp.calendly.com',
  'mcp.asana.com',
  'api.clay.com',
  'mcp.clay.earth',
  'mcp.paypal.com',
  'mcp.granola.ai',
  'mcp.zoom.us',
  'mcp.facebook.com',
  // Gloria — public keyless MCP (free crypto-news tools); native executor
  // in src/clients/gloria-mcp.ts, dispatched internal:gloria.
  'mcp.itsgloria.ai',
  // Marketing connectors (vendor-hosted MCP)
  'mcp.klaviyo.com', 'app.kit.com', 'mcp.omnisend.com', 'mcp.amplitude.com', 'app.pendo.io',
  'mcp.webflow.com', 'mcp.typefully.com', 'install.crustdata.com', 'mcp.tapfiliate.com',
  'mcp.partnerstack.com', 'mcp.crossbeam.com', 'mcp.paddle.com', 'mcp.salesloft.com',
  'mcp.snov.io', 'mcp.sparktoro.com', 'mcp.livestorm.co', 'mcp.coupler.io',
  'mcp.keywordseverywhere.com', 'mcp.tolt.com', 'gateway.demandbase.com',
  // Composio-managed MCP terminator (per-toolkit servers under one host)
  'mcp.composio.dev',
  // Self-hosted sidecar egress domains
  '*.plaid.com',
  // Self-hosted MCP servers run on Cloud Run
  '*.run.app',
  // Localhost sidecars (Phase 1.5)
  'localhost',
  '127.0.0.1',
  // Per-workspace MCP servers (Snowflake + Databricks)
  '*.snowflakecomputing.com',
  '*.azuredatabricks.net',
  '*.gcp.databricks.com',
  '*.cloud.databricks.com',
]);

export interface MCPServerConfig {
  /** Full URL of the MCP server endpoint */
  mcpUrl: string;
  /** Transport protocol */
  transport: 'sse' | 'streamable-http' | 'stdio';
  /** Whether the MCP server is hosted by the vendor (vs self-hosted) */
  isVendorHosted: boolean;
  /** For auto-generated MCP servers: restrict egress to this domain pattern (SE-006) */
  allowedEgressDomain?: string;
  /** Connection timeout override in ms (default 10000 for discovery) */
  discoveryTimeoutMs?: number;
  /** Registered-but-unavailable; requires disabledReason. */
  disabled?: boolean;
  /** Human-readable reason the connector is disabled; MUST be set when disabled. */
  disabledReason?: string;
  /** Optional URL resolver for connectors with per-workspace URLs. */
  urlResolver?: (connectorConfig: Record<string, unknown>) => string;
  /**
   * false → tenant-runtime must NOT fetch OAuth credentials and must NOT
   * set an Authorization header. Set by composio_managed entries; the
   * mcp_url contains a `{user_id}` placeholder that the runtime substitutes
   * with the tenant identity from `getMcpServerConfig.composioUserId`.
   */
  requiresBearerAuth?: boolean;
  /** Composio toolkit slug (only present for composio_managed entries). */
  composioToolkitSlug?: string;
}

function getSidecarBase(): string {
  return process.env.MCP_SIDECAR_URL ?? '';
}

interface MCPServerRegistryEntry extends Omit<MCPServerConfig, 'mcpUrl'> {
  mcpUrl?: string;
  sidecarPath?: string;
}

/**
 * Build the runtime MCP registry from CONNECTORS.
 *
 * For vendor-hosted entries, copies `mcpUrl`, `transport`, and
 * `discoveryTimeoutMs`; if `urlResolverKey` is set, binds the real function
 * from URL_RESOLVERS. For sidecar entries, copies `sidecarPath` and
 * `allowedEgressDomain`; the real URL is built at lookup time in
 * `getMCPServerConfig()` by concatenating `MCP_SIDECAR_URL` env + path.
 */
function buildMcpServerRegistry(): Record<string, MCPServerRegistryEntry> {
  const result: Record<string, MCPServerRegistryEntry> = {};
  // Composio cutover-completion (C5): the disabledComposio set + env lookup
  // that the composio_managed branch consumed are no longer needed here.
  // The switchover (COMPOSIO_DISABLED_CONNECTORS) lives in
  // src/catalog/source-overrides.ts and is read by the boot merge in
  // connector-functions-registry.ts.

  for (const connector of Object.values(CONNECTORS)) {
    if (!connector.mcp) continue;
    const mcp = connector.mcp;
    if (mcp.kind === 'vendor_hosted') {
      const entry: MCPServerRegistryEntry = {
        mcpUrl: mcp.mcpUrl,
        transport: mcp.transport,
        isVendorHosted: true,
        discoveryTimeoutMs: mcp.discoveryTimeoutMs,
      };
      if (mcp.urlResolverKey) {
        entry.urlResolver = URL_RESOLVERS[mcp.urlResolverKey];
      }
      result[connector.type] = entry;
    } else if (mcp.kind === 'sidecar') {
      result[connector.type] = {
        sidecarPath: mcp.sidecarPath,
        transport: mcp.transport ?? 'streamable-http',
        isVendorHosted: false,
        allowedEgressDomain: mcp.allowedEgressDomain,
      };
    } else if (mcp.kind === 'composio_managed') {
      // Composio cutover-completion (C5): composio_managed connectors no
      // longer return an MCP server config. Tool dispatch goes through
      // tenant-runtime's composio-dispatcher in-process (composio.tools.execute),
      // NOT the SDK's vendorMcpServers transport. Skip — getMcpServerConfig
      // returns exists=false for the connector and tenant-runtime's
      // resolveVendorMcpServers loop continues to the next integration.
      continue;
    } else {
      // customer_hosted — URL is resolved at runtime from the tenant's
      // custom_mcp_servers row (handled by tenant-runtime's dispatch path,
      // not by this static registry).
      continue;
    }
  }
  return result;
}

const MCP_SERVER_REGISTRY: Record<string, MCPServerRegistryEntry> = buildMcpServerRegistry();

export function getMCPServerConfig(
  connectorType: string,
  connectorConfig?: Record<string, unknown>,
): MCPServerConfig | null {
  const entry = MCP_SERVER_REGISTRY[connectorType] ?? null;
  if (!entry) return null;
  if (entry.disabled) return null;

  if (!entry.isVendorHosted && entry.sidecarPath !== undefined) {
    const sidecarBase = getSidecarBase();
    if (!sidecarBase) return null;
    const { sidecarPath: _sidecarPath, ...rest } = entry;
    return { ...rest, mcpUrl: `${sidecarBase}${entry.sidecarPath}` } as MCPServerConfig;
  }

  if (!entry.isVendorHosted && !entry.mcpUrl) {
    const sidecarBase = getSidecarBase();
    if (!sidecarBase) return null;
  }

  const { sidecarPath: _sidecarPath2, ...rest } = entry;
  if (entry.urlResolver && connectorConfig) {
    const resolvedUrl = entry.urlResolver(connectorConfig);
    return { ...rest, mcpUrl: resolvedUrl } as MCPServerConfig;
  }

  return { ...rest, mcpUrl: entry.mcpUrl! } as MCPServerConfig;
}

export function getFullRegistryEntry(connectorType: string): MCPServerConfig | null {
  return getMCPServerConfig(connectorType);
}

export interface ConnectorNotAvailableError {
  error: 'connector_not_available';
  connectorType: string;
  reason: string;
}

export function getConnectorNotAvailableError(
  connectorType: string,
): ConnectorNotAvailableError | null {
  const entry = MCP_SERVER_REGISTRY[connectorType];
  if (!entry || !entry.disabled) return null;
  return {
    error: 'connector_not_available',
    connectorType,
    reason: entry.disabledReason ?? 'Connector not available',
  };
}

export function getConnectorMode(connectorType: string): 'rest' | 'mcp' {
  return MCP_SERVER_REGISTRY[connectorType] ? 'mcp' : 'rest';
}

export function getMCPConnectorTypes(): string[] {
  return Object.keys(MCP_SERVER_REGISTRY);
}

export function registerMCPServer(connectorType: string, config: MCPServerConfig): void {
  MCP_SERVER_REGISTRY[connectorType] = config as MCPServerRegistryEntry;
  logger.info(
    { connectorType, mcpUrl: config.mcpUrl, isVendorHosted: config.isVendorHosted },
    'MCP server registered',
  );
}

export function validateMCPUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    if (parsed.username || parsed.password) {
      logger.warn({ url }, 'MCP URL contains userinfo — blocked');
      return false;
    }
    if (hostname.startsWith('[') || hostname.includes(':')) {
      logger.warn({ url, hostname }, 'MCP URL uses IPv6 literal — blocked');
      return false;
    }
    const ipV4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipV4Match) {
      const [, a, b] = ipV4Match.map(Number);
      const isPrivate =
        a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254) ||
        a === 127;
      if (isPrivate && !ALLOWED_MCP_DOMAINS.has(hostname)) {
        logger.warn({ url, hostname }, 'MCP URL resolves to private IP — blocked');
        return false;
      }
    }
    if (parsed.protocol !== 'https:') {
      const isLocalDev = hostname === 'localhost' || hostname === '127.0.0.1';
      if (!isLocalDev) {
        logger.warn({ url }, 'MCP URL uses non-HTTPS in non-local context — blocked');
        return false;
      }
    }
    for (const allowed of ALLOWED_MCP_DOMAINS) {
      if (allowed === hostname) return true;
      if (allowed.startsWith('*.')) {
        const suffix = allowed.slice(1);
        if (hostname.endsWith(suffix)) return true;
      }
    }
    logger.warn({ url, hostname }, 'MCP URL not in allowlist');
    return false;
  } catch {
    logger.error({ url }, 'Invalid MCP URL');
    return false;
  }
}
