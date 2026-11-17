// MCP Server Registry
// Maps connectorType → MCP server config.
// Tells the tool gateway which connectors use MCP vs REST.
// Per MCP Connector Migration Plan Phase 0.2

import { logger } from '../infrastructure/logging';

// URL allowlist for vendor-hosted MCP servers (SE-002)
// Before MCPClient sends credentials, the target URL must match this allowlist.
export const ALLOWED_MCP_DOMAINS = new Set([
  // Vendor-hosted MCP servers
  'mcp.stripe.com',
  'mcp.hubspot.com',
  'api.github.com',
  'api.githubcopilot.com',
  'mcp.github.com',
  'mcp.notion.com',
  'mcp.intuit.com',
  'mcp.xero.com',
  'mcp.intercom.com',
  'mcp.sentry.dev',
  'mcp.linear.app',
  'mcp.calendly.com',
  'mcp.asana.com',
  'mcp.datadoghq.com',
  'mcp.paypal.com',
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
  /**
   * When true, the connector is registered in the registry but is not yet
   * available to agents. getMCPServerConfig returns null; any routing path
   * that checks this flag must return a structured connector_not_available
   * error rather than silently falling through. Required: disabledReason MUST
   * be set whenever disabled is true.
   */
  disabled?: boolean;
  /**
   * Human-readable reason the connector is disabled. MUST be set when
   * `disabled: true`. Used in structured errors returned to callers and in
   * the boot-time conformance check.
   */
  disabledReason?: string;
  /**
   * Optional URL resolver for connectors with per-workspace URLs (e.g. Snowflake, Databricks).
   * When provided, getMCPServerConfig() calls this with the connector's config JSONB to
   * build the final mcpUrl at runtime instead of using the hardcoded mcpUrl.
   */
  urlResolver?: (connectorConfig: Record<string, unknown>) => string;
}

// Self-hosted MCP sidecar base URL.
// Always read from env at call time via getSidecarBase() — never baked into
// registry entry strings at module load. When MCP_SIDECAR_URL is not set,
// getMCPServerConfig() returns null for self-hosted connectors so the tool
// gateway falls through to the REST client path.
function getSidecarBase(): string {
  return process.env.MCP_SIDECAR_URL || '';
}

// Private registry entry type: self-hosted connectors store only the sidecar
// path rather than a full URL. getMCPServerConfig() combines getSidecarBase()
// with the path at call time so the URL is always resolved against the live
// env var, not a value captured at module load.
interface MCPServerRegistryEntry extends Omit<MCPServerConfig, 'mcpUrl'> {
  mcpUrl?: string;        // vendor-hosted: full URL baked in
  sidecarPath?: string;   // self-hosted: path appended to MCP_SIDECAR_URL at call time
  // urlResolver inherited from MCPServerConfig — per-workspace URL derivation
}

// Shorthand factory for self-hosted entries — keeps the table readable.
function sh(sidecarPath: string, allowedEgressDomain?: string): MCPServerRegistryEntry {
  return { sidecarPath, transport: 'streamable-http', isVendorHosted: false, allowedEgressDomain };
}

// Registry: connectorType → MCP server configuration
const MCP_SERVER_REGISTRY: Record<string, MCPServerRegistryEntry> = {
  // --- Vendor-hosted MCP servers (full URL stable, never changes at runtime) ---
  stripe:    { mcpUrl: 'https://mcp.stripe.com',        transport: 'sse', isVendorHosted: true, discoveryTimeoutMs: 10000 },
  hubspot:   { mcpUrl: 'https://mcp.hubspot.com',        transport: 'sse', isVendorHosted: true, discoveryTimeoutMs: 10000 },
  // GitHub MCP — api.githubcopilot.com speaks Streamable HTTP. SSE endpoint
  // returns 405; the correct hostname is api.githubcopilot.com (not api.github.com).
  github:    { mcpUrl: 'https://api.githubcopilot.com/mcp/', transport: 'streamable-http', isVendorHosted: true, discoveryTimeoutMs: 10000 },

  // --- Per-workspace MCP servers (URL derived from connector.config at call time) ---
  snowflake: {
    // PER_WORKSPACE_TEMPLATE: snowflake URL is per-account; urlResolver below
    // substitutes cfg.accountIdentifier at call time. The literal here is only
    // a sentinel — never used as an actual endpoint.
    mcpUrl: 'https://placeholder.snowflakecomputing.com/api/2.0/mcp',
    transport: 'streamable-http',
    isVendorHosted: true,
    discoveryTimeoutMs: 15000,
    urlResolver: (cfg) => `https://${cfg.accountIdentifier}.snowflakecomputing.com/api/2.0/mcp`,
  },
  databricks: {
    // PER_WORKSPACE_TEMPLATE: databricks URL is per-workspace; urlResolver
    // below substitutes cfg.workspaceUrl at call time. The literal here is
    // only a sentinel — never used as an actual endpoint.
    mcpUrl: 'https://placeholder.azuredatabricks.net/api/2.0/mcp/sql',
    transport: 'streamable-http',
    isVendorHosted: true,
    discoveryTimeoutMs: 20000,
    urlResolver: (cfg) => `${cfg.workspaceUrl}/api/2.0/mcp/sql`,
  },

  // --- Phase 2 Priority 1: Official vendor MCP servers ---
  quickbooks: { mcpUrl: 'https://mcp.intuit.com',                                        transport: 'sse',              isVendorHosted: true, discoveryTimeoutMs: 10000 },
  xero:       { mcpUrl: 'https://mcp.xero.com',                                          transport: 'sse',              isVendorHosted: true, discoveryTimeoutMs: 10000 },
  notion:     { mcpUrl: 'https://mcp.notion.com/mcp',                                    transport: 'streamable-http',  isVendorHosted: true, discoveryTimeoutMs: 10000 },
  intercom:   { mcpUrl: 'https://mcp.intercom.com',                                      transport: 'sse',              isVendorHosted: true, discoveryTimeoutMs: 10000 },

  // --- Phase 2 Priority 2: Vendor-hosted (DCR / OAuth) ---
  linear:   { mcpUrl: 'https://mcp.linear.app/mcp',                                      transport: 'streamable-http',  isVendorHosted: true, discoveryTimeoutMs: 10000 },
  asana:    { mcpUrl: 'https://mcp.asana.com/v2/mcp',                                    transport: 'streamable-http',  isVendorHosted: true, discoveryTimeoutMs: 10000 },
  calendly: { mcpUrl: 'https://mcp.calendly.com/mcp',                                    transport: 'streamable-http',  isVendorHosted: true, discoveryTimeoutMs: 10000 },
  paypal:   { mcpUrl: 'https://mcp.paypal.com/sse',                                      transport: 'sse',              isVendorHosted: true, discoveryTimeoutMs: 10000 },
  datadog:  { mcpUrl: 'https://mcp.datadoghq.com/api/unstable/mcp-server/mcp',           transport: 'streamable-http',  isVendorHosted: true, discoveryTimeoutMs: 10000 },
  sentry:   { mcpUrl: 'https://mcp.sentry.dev/mcp',                                      transport: 'streamable-http',  isVendorHosted: true, discoveryTimeoutMs: 10000 },

  // --- Phase 1.5: Self-hosted MCP wrappers (sidecar) ---
  // URL resolved at call time: MCP_SIDECAR_URL + sidecarPath.
  // Tier 1: Google Workspace
  google_mail:      sh('/google/mail',      '*.googleapis.com'),
  google_calendar:  sh('/google/calendar',  '*.googleapis.com'),
  google_drive:     sh('/google/drive',     '*.googleapis.com'),
  google_docs:      sh('/google/docs',      '*.googleapis.com'),
  google_sheets:    sh('/google/sheets',    '*.googleapis.com'),
  google_slides:    sh('/google/slides',    '*.googleapis.com'),
  // Tier 2: Microsoft 365
  microsoft_outlook_mail:     sh('/microsoft/outlook-mail',     '*.microsoft.com'),
  microsoft_outlook_calendar: sh('/microsoft/outlook-calendar', '*.microsoft.com'),
  microsoft_teams:            sh('/microsoft/teams',            '*.microsoft.com'),
  microsoft_todo:             sh('/microsoft/todo',             '*.microsoft.com'),
  microsoft_contacts:         sh('/microsoft/contacts',         '*.microsoft.com'),
  microsoft_onenote:          sh('/microsoft/onenote',          '*.microsoft.com'),
  microsoft_sharepoint:       sh('/microsoft/sharepoint',       '*.microsoft.com'),
  microsoft_planner:          sh('/microsoft/planner',          '*.microsoft.com'),
  microsoft_onedrive:         sh('/microsoft/onedrive',         '*.microsoft.com'),
  // Tier 3: REST-wrapped connectors
  salesforce:  sh('/salesforce',    '*.salesforce.com'),
  slack:       sh('/slack',         '*.slack.com'),
  box:         sh('/box',           '*.box.com'),
  dropbox:     sh('/dropbox',       '*.dropboxapi.com'),
  // Tier 4: Atlassian
  atlassian_jira:       sh('/jira',       '*.atlassian.net'),
  atlassian_confluence: sh('/confluence', '*.atlassian.net'),
  // HubSpot write sidecar
  hubspot_write: sh('/hubspot-write', '*.hubapi.com'),
  // Zendesk
  zendesk: sh('/zendesk', '*.zendesk.com'),
  // Phase 2 self-hosted (OAuth + partner approval required)
  square:    sh('/square',    '*.squareup.com'),
  pipedrive: sh('/pipedrive', '*.pipedrive.com'),
  docusign:  sh('/docusign',  '*.docusign.net'),
  gusto:     sh('/gusto',     '*.gusto.com'),
  rippling:  sh('/rippling',  '*.rippling.com'),
  plaid:     sh('/plaid',     '*.plaid.com'),
  // API-key connectors
  mailchimp:   sh('/mailchimp',   '*.api.mailchimp.com'),
  sendgrid:    sh('/sendgrid',    '*.sendgrid.com'),
  trello:      sh('/trello',      '*.trello.com'),
  bamboohr:    sh('/bamboohr',    '*.bamboohr.com'),
  cal_com:     sh('/cal-com',     '*.cal.com'),
  woocommerce: sh('/woocommerce'),
  // Elicit — AI research assistant. Native sidecar; API served from the apex
  // host elicit.com (no subdomain, so an exact host, not a *.elicit.com wildcard).
  elicit:      sh('/elicit',      'elicit.com'),
};

/**
 * Get MCP server config for a connector type.
 * Returns null if:
 *   - the connector type is not in the registry
 *   - the connector is self-hosted and MCP_SIDECAR_URL is not set
 *   - the connector is marked `disabled: true`
 *
 * For self-hosted connectors the returned mcpUrl is composed from the live
 * MCP_SIDECAR_URL env var at call time — not from a value baked at module
 * load. This means changing MCP_SIDECAR_URL at runtime (e.g. in tests or
 * when the sidecar moves to a new host) takes effect immediately.
 *
 * Callers that need to distinguish "not registered" from "registered but
 * disabled" (e.g., to return a structured error) should call
 * `getFullRegistryEntry` directly.
 */
export function getMCPServerConfig(
  connectorType: string,
  connectorConfig?: Record<string, unknown>
): MCPServerConfig | null {
  const entry = MCP_SERVER_REGISTRY[connectorType] ?? null;
  if (!entry) return null;

  // Explicitly disabled connectors — return null so callers don't try to
  // connect. Callers that want to surface a structured error should use
  // getFullRegistryEntry to check config.disabled first.
  if (entry.disabled) return null;

  if (!entry.isVendorHosted && entry.sidecarPath !== undefined) {
    // Self-hosted connector with a sidecar path — resolve URL from env NOW
    // (not at module load) so tests and runtime config changes take effect.
    const sidecarBase = getSidecarBase();
    if (!sidecarBase) return null;
    const { sidecarPath, ...rest } = entry;
    return { ...rest, mcpUrl: `${sidecarBase}${sidecarPath}` } as MCPServerConfig;
  }

  if (!entry.isVendorHosted && !entry.mcpUrl) {
    // Self-hosted with no path and no mcpUrl (shouldn't happen in practice, but guard).
    const sidecarBase = getSidecarBase();
    if (!sidecarBase) return null;
  }

  // Apply per-workspace URL resolver if present (e.g. Snowflake, Databricks)
  const { sidecarPath: _sidecarPath, ...rest } = entry;
  if (entry.urlResolver && connectorConfig) {
    const resolvedUrl = entry.urlResolver(connectorConfig);
    return { ...rest, mcpUrl: resolvedUrl } as MCPServerConfig;
  }

  // Vendor-hosted or externally-registered with explicit mcpUrl — use as-is.
  return { ...rest, mcpUrl: entry.mcpUrl! } as MCPServerConfig;
}

/**
 * Get the raw registry entry for a connector type, including disabled entries.
 * Used by the conformance checker and routing paths that need to return a
 * structured error for disabled connectors rather than silently falling through.
 */
export function getFullRegistryEntry(connectorType: string): MCPServerConfig | null {
  // Return config through getMCPServerConfig to ensure URL is properly resolved.
  // For disabled connectors this returns null; callers that need to see disabled
  // entries should inspect the registry directly via getConnectorNotAvailableError.
  return getMCPServerConfig(connectorType);
}

/**
 * Structured error returned when a connector is registered but disabled.
 * Callers (tool gateway, MCP client factory) must check for this and surface
 * the error to the agent so it can inform the user.
 */
export interface ConnectorNotAvailableError {
  error: 'connector_not_available';
  connectorType: string;
  reason: string;
}

/**
 * Check whether a connector is registered-but-disabled and return a structured
 * error object if so. Returns null if the connector is available or not registered.
 * Wire this into any routing path that currently silently falls through when the
 * sidecar is missing.
 */
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

/**
 * Check whether a connector type uses MCP or REST.
 */
export function getConnectorMode(connectorType: string): 'rest' | 'mcp' {
  return MCP_SERVER_REGISTRY[connectorType] ? 'mcp' : 'rest';
}

/**
 * Get all connector types that have MCP servers registered.
 */
export function getMCPConnectorTypes(): string[] {
  return Object.keys(MCP_SERVER_REGISTRY);
}

/**
 * Register a new MCP server for a connector type.
 * Used by Phase 1.5 (self-hosted wrappers) and Phase 2 (new connectors).
 */
export function registerMCPServer(connectorType: string, config: MCPServerConfig): void {
  MCP_SERVER_REGISTRY[connectorType] = config as MCPServerRegistryEntry;
  logger.info('MCP server registered', { connectorType, mcpUrl: config.mcpUrl, isVendorHosted: config.isVendorHosted });
}

/**
 * Validate that a URL is in the allowed MCP domains list (SE-002).
 * Must be called before sending Bearer tokens to any MCP server.
 */
export function validateMCPUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    const hostname = parsed.hostname;

    // Block userinfo in URL (e.g., https://admin:pass@evil.com/mcp.stripe.com)
    if (parsed.username || parsed.password) {
      logger.warn('MCP URL contains userinfo — blocked', { url });
      return false;
    }

    // Block IPv6-mapped IPv4 addresses that could bypass hostname checks
    // (e.g., [::ffff:169.254.169.254], [::1], [fe80::1])
    if (hostname.startsWith('[') || hostname.includes(':')) {
      logger.warn('MCP URL uses IPv6 literal — blocked', { url, hostname });
      return false;
    }

    // Block link-local and metadata IPs (169.254.x.x, 10.x.x.x, 192.168.x.x, etc.)
    // These could be used for SSRF against Cloud metadata or internal VPC services.
    const ipV4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipV4Match) {
      const [, a, b] = ipV4Match.map(Number);
      const isPrivate = a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254) || // Link-local / cloud metadata
        a === 127; // Loopback (except explicit localhost allowlist)

      // Allow explicit localhost entries in the allowlist
      if (isPrivate && !ALLOWED_MCP_DOMAINS.has(hostname)) {
        logger.warn('MCP URL resolves to private IP — blocked', { url, hostname });
        return false;
      }
    }

    // Block non-HTTPS in production (allow HTTP for localhost/127.0.0.1 dev)
    if (parsed.protocol !== 'https:') {
      const isLocalDev = hostname === 'localhost' || hostname === '127.0.0.1';
      if (!isLocalDev) {
        logger.warn('MCP URL uses non-HTTPS in non-local context — blocked', { url });
        return false;
      }
    }

    // Allowlist check
    for (const allowed of ALLOWED_MCP_DOMAINS) {
      // Exact match
      if (allowed === hostname) return true;
      // Wildcard match (e.g., *.run.app)
      if (allowed.startsWith('*.')) {
        const suffix = allowed.slice(1); // '.run.app'
        if (hostname.endsWith(suffix)) return true;
      }
    }

    logger.warn('MCP URL not in allowlist', { url, hostname });
    return false;
  } catch {
    logger.error('Invalid MCP URL', { url });
    return false;
  }
}
