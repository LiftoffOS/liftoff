/**
 * Read a human-readable account identifier off a Connector row for use as
 * the Connected-card subtitle.
 *
 * Resolution order (first match wins):
 *
 *   1. `config.externalAccountLabel` — canonical field written by the
 *      backend OAuth callback's per-provider identity fetcher (see
 *      liftoff-connector-service/src/oauth/identity-fetchers.ts). Present
 *      for every multi-instance OAuth provider we have a fetcher for.
 *
 *   2. `config.email` — legacy field from the Gmail-only special-case in
 *      the pre-generalization release. Kept for backward compat on rows
 *      that haven't been reconnected since the identity-fetcher
 *      generalization shipped.
 *
 *   3. URL-shaped fields in config — for connectors keyed on a per-instance
 *      URL or subdomain rather than an account id (Custom MCP Server,
 *      Zendesk, BambooHR, WooCommerce, etc.). Checked in decreasing
 *      specificity. Any value here disambiguates the instance even when no
 *      whoami response is available.
 *
 *   4. Connector-row `apiKeyHint` — masked last-4-chars of the API key for
 *      API-key connectors (e.g. "…x4f9"). Always disambiguates separate
 *      instances of the same API-key connector even when nothing else is
 *      written.
 *
 * Returns `undefined` only when the row truly carries nothing useful — the
 * caller decides whether to render a final fallback (typically the connector
 * type / category label).
 */
interface ConnectorLike {
  config?: Record<string, unknown> | null
  apiKeyHint?: string | null
}

export function connectedAccountLabel(
  connector: ConnectorLike | undefined | null,
): string | undefined {
  if (!connector) return undefined
  const cfg = (connector.config ?? {}) as {
    // Canonical identity (preferred)
    externalAccountLabel?: string
    // Legacy
    email?: string
    // URL-shaped per-instance identifiers (Custom MCP, vendor-hosted MCPs with per-tenant URLs)
    serverUrl?: string
    mcpUrl?: string
    // endpointUrl is the field name custom_mcp_server writes (see
    // platform-backend custom-mcp-servers/service.ts config builder).
    endpointUrl?: string
    // baseUrl is what custom_api_connector writes: the address every one of
    // its requests is built from, and the only thing that tells two custom
    // API connections apart at a glance.
    baseUrl?: string
    url?: string
    // Subdomain-scoped providers (Zendesk, BambooHR, etc.)
    subdomain?: string
    accountIdentifier?: string
    // Workspace/site identifiers
    workspaceUrl?: string
    siteUrl?: string
    domain?: string
    // Display-only fallbacks the backend might have written
    name?: string
    displayName?: string
    label?: string
  }

  const candidates: Array<string | undefined | null> = [
    cfg.externalAccountLabel,
    cfg.email,
    cfg.serverUrl,
    cfg.mcpUrl,
    cfg.endpointUrl,
    cfg.baseUrl,
    cfg.url,
    cfg.workspaceUrl,
    cfg.siteUrl,
    cfg.domain,
    cfg.subdomain,
    cfg.accountIdentifier,
    cfg.displayName,
    cfg.name,
    cfg.label,
    connector.apiKeyHint,
  ]

  for (const c of candidates) {
    if (typeof c === 'string' && c.trim().length > 0) return c
  }
  return undefined
}
