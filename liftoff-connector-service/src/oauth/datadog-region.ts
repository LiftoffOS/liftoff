// Datadog region (site) helpers.
//
// Datadog OAuth + MCP are region-scoped: a client registered against one site's
// authorization server is not valid at another's (switching region in Datadog's
// consent popup yields "Mismatching redirect URI"). So the connect flow must
// discover + register + authorize against the user's actual site, and the same
// site must drive token refresh and the MCP/polling host.
//
// The site is the Datadog web domain (e.g. `us3.datadoghq.com`). From it we
// derive every region-specific URL. The default is US1 (`datadoghq.com`).

export const DATADOG_DEFAULT_SITE = 'datadoghq.com';

// Allowlist of Datadog sites. Doubles as SSRF defense-in-depth: only these
// exact hosts can be turned into discovery/token/MCP URLs.
//
// Only the commercial regions are listed: all six expose the MCP OAuth discovery
// (verified live at mcp.<site>/.well-known/oauth-protected-resource). The FED
// regions are intentionally excluded — US1-FED (ddog-gov.com) serves an HTML
// login instead of the OAuth discovery document, and US2-FED (us2.ddog-gov.com)
// is still in process for IL5 authorization. They cannot complete the DCR/MCP
// flow, so offering them would only surface broken connect attempts.
export const DATADOG_SITES = [
  'datadoghq.com', // US1 - East
  'us3.datadoghq.com', // US3 - West
  'us5.datadoghq.com', // US5 - Central
  'datadoghq.eu', // EU1 - Europe
  'ap1.datadoghq.com', // AP1 - Japan
  'ap2.datadoghq.com', // AP2 - Australia
] as const;

export type DatadogSite = (typeof DATADOG_SITES)[number];

export function isValidDatadogSite(site: string): site is DatadogSite {
  return (DATADOG_SITES as readonly string[]).includes(site);
}

/** Normalize/validate a caller-supplied site, falling back to US1. */
export function resolveDatadogSite(site: string | undefined | null): DatadogSite {
  const s = (site ?? '').trim().toLowerCase();
  return isValidDatadogSite(s) ? s : DATADOG_DEFAULT_SITE;
}

/** DCR discovery base — the region's MCP host. */
export function datadogDiscoveryBaseUrl(site: string): string {
  return `https://mcp.${resolveDatadogSite(site)}`;
}

/** REST/OAuth issuer base for token endpoints. */
export function datadogApiBaseUrl(site: string): string {
  return `https://api.${resolveDatadogSite(site)}`;
}

/** Region-qualified registration key used to isolate the DCR cache/DB row. */
export function datadogRegistrationKey(site: string): string {
  return `datadog@${resolveDatadogSite(site)}`;
}

/** Region's MCP server URL used by agent access + the polling client. */
export function datadogMcpUrl(site: string): string {
  return `https://mcp.${resolveDatadogSite(site)}/api/unstable/mcp-server/mcp`;
}

// Scope-sentinel helpers (mirrors the Zendesk `subdomain:` pattern). The site is
// persisted on the OAuth state / connection scopes so the callback, refresh, and
// polling paths can all recover the region.
export const DATADOG_SITE_SENTINEL_PREFIX = 'site:';

export function datadogSiteSentinel(site: string): string {
  return `${DATADOG_SITE_SENTINEL_PREFIX}${resolveDatadogSite(site)}`;
}

export function siteFromSentinels(scopes: string[] | null | undefined): DatadogSite {
  const hit = scopes?.find(s => s.startsWith(DATADOG_SITE_SENTINEL_PREFIX));
  return resolveDatadogSite(hit ? hit.slice(DATADOG_SITE_SENTINEL_PREFIX.length) : undefined);
}
