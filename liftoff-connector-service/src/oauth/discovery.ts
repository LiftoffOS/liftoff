// OAuth Discovery + Dynamic Client Registration (RFC 7591).
//
// Ported from platform-backend/src/connectors/oauth-discovery.ts. Adapts:
//   - pool  → withAdminScope (connector-pg). DCR rows are platform-level
//     (cross-tenant) so we bypass RLS via the connector_admin role.
//   - log   → logger (infra/logging.ts)
//   - secrets → storeConnectorCredential is tenant-scoped; registration
//     access tokens are platform-level, so we keep a direct
//     SecretManagerServiceClient call here using the platform / shared
//     project. Same behaviour as the source.
//
// SSRF protection is kept intact — requests to discovery + auth-server +
// registration endpoints are filtered against an allowlist, with explicit
// rejection of localhost, IPv6 literals, and RFC 1918 / link-local / loopback
// / metadata IPs.
//
// Discovered registrations are persisted to connector-pg's
// oauth_dynamic_registrations table (see migration 004). The provider key
// matches OAUTH_PROVIDER_CONFIGS[provider] in types.ts.

import { SecretManagerServiceClient } from '@google-cloud/secret-manager';
import { withAdminScope } from '../db/pool.js';
import { logger } from '../infra/logging.js';
import { OAUTH_PROVIDER_CONFIGS, OAuthProvider, isDiscoveryConfig } from '../types.js';

const secretManagerClient = new SecretManagerServiceClient();

// --- SSRF Protection ---

const ALLOWED_DISCOVERY_DOMAINS = new Set([
  'mcp.notion.com', 'api.notion.com', 'notion.com', 'notion.so',
  'mcp.linear.app', 'linear.app',
  // GitLab.com first-party MCP (/api/v4/mcp) + DCR. Issuer, authorize, token, and
  // registration_endpoint are all on gitlab.com (verified from the live discovery docs), so the
  // single apex host covers the whole OAuth dance.
  'gitlab.com',
  'mcp.calendly.com', 'calendly.com', 'auth.calendly.com',
  'mcp.asana.com', 'asana.com', 'app.asana.com',
  'mcp.datadoghq.com', 'datadoghq.com',
  'mcp.paypal.com', 'paypal.com',
  'api.clay.com', 'app.clay.com', 'clay.com',
  'mcp.clay.earth', 'clay.earth',
  'mcp.granola.ai', 'mcp-auth.granola.ai', 'granola.ai',
  'mcp.attio.com', 'app.attio.com', 'attio.com',
  // Stripe's MCP delegates auth to access.stripe.com/mcp (RFC 9728 →
  // RFC 7591). Both hosts are on the dance, plus the apex as a hedge.
  'mcp.stripe.com', 'access.stripe.com', 'stripe.com',
  'mcp.pandadoc.com', 'pandadoc.com',
  // GTM / market-intelligence connectors (vendor-hosted MCP + DCR). Per vendor
  // the OAuth dance spans multiple hosts (auth server ≠ MCP host), and
  // isAllowedDiscoveryUrl gates every one — protected-resource, auth-server
  // metadata, authorize, token, AND register. Each host below was read from the
  // vendor's live discovery documents; apex included as a hedge.
  'mcp.zoominfo.com', 'okta-login.zoominfo.com', 'zoominfo.com',
  'api.outreach.io', 'outreach.io',
  'api.ahrefs.com', 'app.ahrefs.com', 'ahrefs.com',
  'mcp.supermetrics.com', 'api.supermetrics.com', 'supermetrics.com',
  'mcp.similarweb.com', 'mcp-auth.similarweb.com', 'similarweb.com',
  'mcp.commonroom.io', 'login.commonroom.io', 'commonroom.io',
  // Marketing connectors (vendor-hosted MCP + DCR), hosts read from each vendor's live
  // discovery documents; apex included as a hedge.
  'mcp.klaviyo.com', 'klaviyo.com',
  'app.kit.com', 'api.kit.com', 'kit.com',
  'mcp.omnisend.com', 'app.omnisend.com', 'omnisend.com',
  'mcp.amplitude.com', 'amplitude.com',
  'app.pendo.io', 'pendo.io',
  'mcp.webflow.com', 'webflow.com',
  'mcp.typefully.com', 'api.typefully.com', 'typefully.com',
  'install.crustdata.com', 'crustdata.com',
  'mcp.tapfiliate.com', 'app.tapfiliate.com', 'api.tapfiliate.com', 'tapfiliate.com',
  'mcp.partnerstack.com', 'partnerstack.com',
  'mcp.crossbeam.com', 'crossbeam.com',
  'mcp.paddle.com', 'id.paddle.com', 'paddle.com',
  'mcp.salesloft.com', 'accounts.salesloft.com', 'salesloft.com',
  'mcp.snov.io', 'app.snov.io', 'snov.io',
  'mcp.sparktoro.com', 'sparktoro.com',
  'mcp.livestorm.co', 'livestorm.co',
  'mcp.coupler.io', 'auth.coupler.io', 'coupler.io',
  'mcp.keywordseverywhere.com', 'keywordseverywhere.com',
  'gateway.demandbase.com', 'authentication.demandbase.com', 'demandbase.com',
]);

// Providers whose authorization-server metadata declares an issuer on a different origin
// than the server that serves it. RFC 8414 §3.3 exists to stop a mix-up attack, and pinning
// the expected issuer in code keeps that protection: the comparison is still exact, it is
// just made against a value we chose rather than the origin we fetched from.
const EXPECTED_ISSUER_BY_PROVIDER: Record<string, string> = {
  omnisend: 'https://app.omnisend.com',
  tapfiliate: 'https://api.tapfiliate.com',
  demandbase: 'https://authentication.demandbase.com/oauth2/aus7fu7m8kDj90Z532p7',
};

export function isAllowedDiscoveryUrl(url: string): boolean {
  try {
    const parsed = new URL(url);

    // Must be HTTPS
    if (parsed.protocol !== 'https:') {
      logger.warn({ url }, 'Discovery URL rejected: not HTTPS');
      return false;
    }

    // Block IPv6 literals
    if (parsed.hostname.startsWith('[')) {
      logger.warn({ url }, 'Discovery URL rejected: IPv6 literal');
      return false;
    }

    // Block private / link-local / metadata / loopback IPs
    const ipMatch = parsed.hostname.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
    if (ipMatch) {
      const [, a, b] = ipMatch.map(Number);
      const isPrivate =
        a === 10 ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 169 && b === 254) ||
        a === 127 ||
        a === 0;
      if (isPrivate) {
        logger.warn({ url }, 'Discovery URL rejected: private IP');
        return false;
      }
    }

    // Block literal hostnames that resolve to private infrastructure
    const hostname = parsed.hostname.toLowerCase();
    if (hostname === 'localhost' || hostname === 'metadata.google.internal') {
      logger.warn({ url, hostname }, 'Discovery URL rejected: blocked hostname');
      return false;
    }

    // Check hostname against allowlist (exact match or subdomain)
    for (const allowed of ALLOWED_DISCOVERY_DOMAINS) {
      if (hostname === allowed || hostname.endsWith(`.${allowed}`)) {
        return true;
      }
    }

    logger.warn({ url, hostname }, 'Discovery URL rejected: not in allowlist');
    return false;
  } catch {
    logger.warn({ url }, 'Discovery URL rejected: invalid URL');
    return false;
  }
}

// --- Schema Validation (RFC 8414 / RFC 7591) ---
//
// Hand-rolled validators (zod is not a dependency in this service).

interface OAuthProtectedResource {
  authorization_servers: string[];
}

interface OAuthAuthorizationServer {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
}

interface DynamicRegistrationResponse {
  client_id: string;
  client_secret?: string;
  client_id_issued_at?: number;
  client_secret_expires_at?: number;
  registration_access_token?: string;
  registration_client_uri?: string;
  service_redirect_uri?: string;
}

function isHttpsUrl(value: unknown): value is string {
  if (typeof value !== 'string' || value.length === 0) return false;
  try {
    return new URL(value).protocol === 'https:';
  } catch {
    return false;
  }
}

function parseProtectedResource(data: unknown): OAuthProtectedResource {
  if (!data || typeof data !== 'object') {
    throw new OAuthDiscoveryError('Invalid protected-resource metadata (not an object)', 'schema_invalid');
  }
  const d = data as Record<string, unknown>;
  if (!Array.isArray(d.authorization_servers) || d.authorization_servers.length === 0) {
    throw new OAuthDiscoveryError('Invalid protected-resource metadata (authorization_servers)', 'schema_invalid');
  }
  for (const srv of d.authorization_servers) {
    if (!isHttpsUrl(srv)) {
      throw new OAuthDiscoveryError('Invalid authorization_servers entry (not HTTPS URL)', 'schema_invalid');
    }
  }
  return { authorization_servers: d.authorization_servers as string[] };
}

function parseAuthorizationServer(data: unknown): OAuthAuthorizationServer {
  if (!data || typeof data !== 'object') {
    throw new OAuthDiscoveryError('Invalid authorization-server metadata (not an object)', 'schema_invalid');
  }
  const d = data as Record<string, unknown>;
  for (const field of ['issuer', 'authorization_endpoint', 'token_endpoint'] as const) {
    if (!isHttpsUrl(d[field])) {
      throw new OAuthDiscoveryError(`Invalid authorization-server metadata (${field})`, 'schema_invalid');
    }
  }
  if (d.registration_endpoint !== undefined && !isHttpsUrl(d.registration_endpoint)) {
    throw new OAuthDiscoveryError('Invalid registration_endpoint (not HTTPS URL)', 'schema_invalid');
  }
  return {
    issuer: d.issuer as string,
    authorization_endpoint: d.authorization_endpoint as string,
    token_endpoint: d.token_endpoint as string,
    registration_endpoint: d.registration_endpoint as string | undefined,
  };
}

export function _parseRegistrationResponseForTesting(data: unknown, registrationEndpoint: string): DynamicRegistrationResponse {
  return parseRegistrationResponse(data, registrationEndpoint);
}

function parseRegistrationResponse(data: unknown, registrationEndpoint: string): DynamicRegistrationResponse {
  if (!data || typeof data !== 'object') {
    throw new OAuthDiscoveryError('Invalid DCR response (not an object)', 'schema_invalid');
  }
  const d = data as Record<string, unknown>;
  if (typeof d.client_id !== 'string' || d.client_id.length === 0) {
    throw new OAuthDiscoveryError('Invalid DCR response (client_id)', 'schema_invalid');
  }

  // Resolve registration_client_uri: some providers (e.g. Datadog) return a
  // relative path instead of an absolute HTTPS URL. Resolve against the
  // registration endpoint origin before validating.
  let registrationClientUri: string | undefined;
  if (typeof d.registration_client_uri === 'string' && d.registration_client_uri.length > 0) {
    const raw = d.registration_client_uri;
    const resolved = isHttpsUrl(raw) ? raw : (() => {
      try {
        return new URL(raw, registrationEndpoint).toString();
      } catch {
        return undefined;
      }
    })();
    if (resolved !== undefined && !isHttpsUrl(resolved)) {
      throw new OAuthDiscoveryError('Invalid DCR response (registration_client_uri)', 'schema_invalid');
    }
    registrationClientUri = resolved;
  }

  const serviceRedirectUri =
    typeof d.service_redirect_uri === 'string' && isHttpsUrl(d.service_redirect_uri)
      ? d.service_redirect_uri
      : undefined;

  return {
    client_id: d.client_id,
    client_secret: typeof d.client_secret === 'string' ? d.client_secret : undefined,
    client_id_issued_at: typeof d.client_id_issued_at === 'number' ? d.client_id_issued_at : undefined,
    client_secret_expires_at:
      typeof d.client_secret_expires_at === 'number' ? d.client_secret_expires_at : undefined,
    registration_access_token:
      typeof d.registration_access_token === 'string' ? d.registration_access_token : undefined,
    registration_client_uri: registrationClientUri,
    service_redirect_uri: serviceRedirectUri,
  };
}

// --- Types ---

export interface DiscoveredOAuthConfig {
  authorizationEndpoint: string;
  tokenEndpoint: string;
  clientId: string;
  // Some providers (e.g. Datadog MCP) return a service_redirect_uri that must
  // be used in place of our own callback URL in both the authorization request
  // and token exchange. The provider proxies the code back to our registered
  // redirect_uri after the user authorizes.
  serviceRedirectUri?: string;
}

interface CachedDiscovery {
  config: DiscoveredOAuthConfig;
  cachedAt: number;
}

// --- In-memory cache ---

const REGISTRATION_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours
const INVALIDATION_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes

const discoveryCache = new Map<string, CachedDiscovery>();
const invalidationCooldowns = new Map<string, number>();

// Mutex: prevents concurrent registration attempts per provider
const registrationLocks = new Map<string, Promise<DiscoveredOAuthConfig>>();

// --- Core public API ---

/**
 * Get discovered OAuth config for a provider.
 * Cache order: in-memory → DB → discover + register.
 * Uses a mutex to prevent concurrent registration attempts.
 */
export async function getDiscoveredOAuthConfig(
  provider: string,
  opts?: { registrationKey?: string; discoveryBaseUrl?: string },
): Promise<DiscoveredOAuthConfig> {
  // Region-aware providers (e.g. Datadog: US1/US3/US5/EU/AP1) reuse the same
  // base provider but discover + register against a per-region host. The
  // registrationKey isolates the cache/DB/lock/secret per region, while the
  // discoveryBaseUrl override points discovery at that region's MCP host.
  // Both default to the provider's static config, so non-region callers are
  // unchanged.
  const key = opts?.registrationKey ?? provider;
  const discoveryBaseUrl = opts?.discoveryBaseUrl;

  // Check invalidation cooldown
  const cooldownExpiry = invalidationCooldowns.get(key);
  if (cooldownExpiry && Date.now() < cooldownExpiry) {
    const remainingSec = Math.ceil((cooldownExpiry - Date.now()) / 1000);
    throw new OAuthDiscoveryError(
      `Registration for ${key} was recently invalidated. Retry in ${remainingSec}s.`,
      'discovery_cooldown',
    );
  }

  // 1. In-memory cache
  const cached = discoveryCache.get(key);
  if (cached && Date.now() - cached.cachedAt < REGISTRATION_TTL_MS) {
    return cached.config;
  }

  // 2. DB lookup
  const dbRow = await loadFromDb(key);
  if (dbRow && !dbRow.isStale) {
    const config: DiscoveredOAuthConfig = {
      authorizationEndpoint: dbRow.authorization_endpoint,
      tokenEndpoint: dbRow.token_endpoint,
      clientId: dbRow.client_id,
      serviceRedirectUri:
        typeof dbRow.metadata?.service_redirect_uri === 'string'
          ? dbRow.metadata.service_redirect_uri
          : undefined,
    };
    discoveryCache.set(key, { config, cachedAt: Date.now() });
    return config;
  }

  // 3. Discover + register (mutex-guarded)
  const existing = registrationLocks.get(key);
  if (existing) return existing;

  const promise = discoverAndRegister(provider, key, discoveryBaseUrl)
    .finally(() => {
      registrationLocks.delete(key);
    })
    .catch((err) => {
      // GAP-3 / BE-007: If discovery fails and we have a stale DB row, use it
      if (dbRow?.isStale) {
        logger.warn(
          { provider, error: err.message, staleUpdatedAt: dbRow.updated_at },
          'Discovery failed — falling back to stale DB registration',
        );
        const config: DiscoveredOAuthConfig = {
          authorizationEndpoint: dbRow.authorization_endpoint,
          tokenEndpoint: dbRow.token_endpoint,
          clientId: dbRow.client_id,
          serviceRedirectUri:
            typeof dbRow.metadata?.service_redirect_uri === 'string'
              ? dbRow.metadata.service_redirect_uri
              : undefined,
        };
        discoveryCache.set(key, { config, cachedAt: Date.now() });
        return config;
      }
      throw err;
    });

  registrationLocks.set(key, promise);
  return promise;
}

// Lightweight cache for endpoints fetched outside of full DCR.
// Only used by the local-dev override path in the OAuth router.
interface CachedEndpoints {
  authorizationEndpoint: string;
  tokenEndpoint: string;
}
const authEndpointCache = new Map<string, CachedEndpoints>();

async function fetchEndpointsOnly(provider: string): Promise<CachedEndpoints> {
  const cached = authEndpointCache.get(provider);
  if (cached) return cached;

  const discoveryBaseUrl = getDiscoveryBaseUrl(provider);
  const authServerUrl = await resolveAuthServerUrl(provider, discoveryBaseUrl, ' (auth-endpoint-only)');
  const asData = await fetchAuthServerMetadata(provider, authServerUrl, ' (auth-endpoint-only)');

  if (!isAllowedDiscoveryUrl(asData.authorization_endpoint)) {
    throw new OAuthDiscoveryError(
      `Discovered authorization_endpoint not allowed: ${asData.authorization_endpoint}`,
      'ssrf_blocked',
    );
  }

  const endpoints: CachedEndpoints = {
    authorizationEndpoint: asData.authorization_endpoint,
    tokenEndpoint: asData.token_endpoint,
  };
  authEndpointCache.set(provider, endpoints);
  return endpoints;
}

/**
 * Fetch just the authorization_endpoint for a provider's discoveryBaseUrl.
 * No DCR registration or DB access. For the local-dev override path.
 */
export async function fetchAuthorizationEndpointOnly(provider: string): Promise<string> {
  return (await fetchEndpointsOnly(provider)).authorizationEndpoint;
}

/**
 * Fetch just the token_endpoint for a provider's discoveryBaseUrl.
 * No DCR registration or DB access. For the local-dev override path callback.
 */
export async function fetchTokenEndpointOnly(provider: string): Promise<string> {
  return (await fetchEndpointsOnly(provider)).tokenEndpoint;
}

/**
 * Invalidate a provider's registration (e.g. after invalid_client error).
 * Enforces a cooldown period before re-registration is allowed.
 */
export async function invalidateDiscoveredRegistration(provider: string): Promise<void> {
  logger.warn({ provider }, 'Invalidating OAuth dynamic registration');

  discoveryCache.delete(provider);

  await withAdminScope(
    { caller: 'oauth/discovery.invalidateDiscoveredRegistration', reason: 'DCR invalidation' },
    async (client) => {
      await client.query(
        'DELETE FROM oauth_dynamic_registrations WHERE provider = $1',
        [provider],
      );
    },
  );

  invalidationCooldowns.set(provider, Date.now() + INVALIDATION_COOLDOWN_MS);

  logger.info(
    { provider, cooldownMs: INVALIDATION_COOLDOWN_MS },
    'Registration invalidated with cooldown',
  );
}

// --- Internal functions ---

// Resolve the authorization-server base URL for a discovery provider.
// Prefers RFC 9728 protected-resource metadata at the host root. Some MCP servers
// scope PRM under the resource path instead (e.g. Clay.com publishes it at
// /.well-known/oauth-protected-resource/v3/mcp, so the host-level path returns an
// HTML 404). When the host-level PRM is missing or non-JSON, fall back to treating
// the discovery base itself as the authorization server.
/**
 * Candidate well-known URLs for an authorization server, in priority order.
 *
 * RFC 8414 §3.1: when the issuer carries a PATH, the well-known segment is
 * INSERTED between host and path — `https://host/.well-known/oauth-authorization-server/mcp`
 * — it is not appended to the path and the path is not dropped. We used to build
 * `new URL('/.well-known/oauth-authorization-server', issuer)`, which discards
 * the path entirely, so every path-bearing authorization server 404'd and
 * surfaced as "Invalid authorization-server metadata (issuer)" — the parse
 * failing on Stripe's 404 body rather than anything about the issuer.
 *
 * Stripe is the first we hit (issuer `https://access.stripe.com/mcp`), but this
 * is not vendor-specific: any provider whose issuer has a path was unreachable.
 * The OIDC-style suffix form and the bare root form follow as fallbacks, since
 * servers in the wild publish at all three.
 */
export function authServerMetadataUrls(authServerUrl: string): string[] {
  const u = new URL(authServerUrl);
  const path = u.pathname.replace(/\/+$/, '');
  const candidates: string[] = [];
  if (path && path !== '') {
    candidates.push(`${u.origin}/.well-known/oauth-authorization-server${path}`);
    candidates.push(`${u.origin}${path}/.well-known/oauth-authorization-server`);
  }
  candidates.push(`${u.origin}/.well-known/oauth-authorization-server`);
  return [...new Set(candidates)];
}

/**
 * Fetch + parse authorization-server metadata, trying each candidate location.
 * Returns the parsed document, or throws the last failure when none work.
 */
async function fetchAuthServerMetadata(
  provider: string,
  authServerUrl: string,
  logLabel: string,
): Promise<OAuthAuthorizationServer> {
  const candidates = authServerMetadataUrls(authServerUrl);
  let lastErr: Error | null = null;
  for (const url of candidates) {
    if (!isAllowedDiscoveryUrl(url)) {
      lastErr = new OAuthDiscoveryError(`Auth server URL not allowed: ${url}`, 'ssrf_blocked');
      continue;
    }
    try {
      logger.info({ provider, url }, `Fetching OAuth authorization server metadata${logLabel}`);
      const res = await fetchWithTimeout(url);
      return parseAuthorizationServer(await res.json());
    } catch (err) {
      lastErr = err as Error;
    }
  }
  throw lastErr ?? new OAuthDiscoveryError('No authorization-server metadata found', 'schema_invalid');
}

async function resolveAuthServerUrl(
  provider: string,
  discoveryBaseUrl: string,
  logLabel: string,
): Promise<string> {
  const protectedResourceUrl = `${discoveryBaseUrl}/.well-known/oauth-protected-resource`;
  if (!isAllowedDiscoveryUrl(protectedResourceUrl)) {
    throw new OAuthDiscoveryError(
      `Discovery URL not allowed: ${protectedResourceUrl}`,
      'ssrf_blocked',
    );
  }
  logger.info({ provider, url: protectedResourceUrl }, `Fetching OAuth protected resource metadata${logLabel}`);
  try {
    const prResponse = await fetchWithTimeout(protectedResourceUrl);
    if (prResponse.ok) {
      const prData = parseProtectedResource(await prResponse.json());
      return prData.authorization_servers[0];
    }
    logger.info(
      { provider, status: prResponse.status },
      'Host-level protected-resource metadata unavailable — using discovery base as authorization server',
    );
  } catch (err) {
    logger.info(
      { provider, error: (err as Error).message },
      'Protected-resource metadata fetch/parse failed — using discovery base as authorization server',
    );
  }
  return discoveryBaseUrl;
}

async function discoverAndRegister(
  provider: string,
  registrationKey: string = provider,
  discoveryBaseUrlOverride?: string,
): Promise<DiscoveredOAuthConfig> {
  const discoveryBaseUrl = discoveryBaseUrlOverride ?? getDiscoveryBaseUrl(provider);

  // Step 1: Resolve the authorization server (RFC 9728 protected-resource
  // metadata, with a fallback to the discovery base — see resolveAuthServerUrl).
  const authServerUrl = await resolveAuthServerUrl(provider, discoveryBaseUrl, '');

  // Step 2: Fetch authorization server metadata
  const asData = await fetchAuthServerMetadata(provider, authServerUrl, '');

  // Validate issuer matches origin (RFC 8414 §3.3)
  const expectedOrigin = new URL(EXPECTED_ISSUER_BY_PROVIDER[provider] ?? authServerUrl).origin;
  const issuerOrigin = new URL(asData.issuer).origin;
  if (issuerOrigin !== expectedOrigin) {
    throw new OAuthDiscoveryError(
      `Issuer mismatch: expected origin ${expectedOrigin}, got ${issuerOrigin}`,
      'issuer_mismatch',
    );
  }

  for (const endpoint of [
    asData.authorization_endpoint,
    asData.token_endpoint,
    asData.registration_endpoint,
  ]) {
    if (endpoint && !isAllowedDiscoveryUrl(endpoint)) {
      throw new OAuthDiscoveryError(
        `Discovered endpoint not allowed: ${endpoint}`,
        'ssrf_blocked',
      );
    }
  }

  if (!asData.registration_endpoint) {
    throw new OAuthDiscoveryError(
      `Provider ${provider} does not support dynamic client registration (no registration_endpoint)`,
      'no_registration_endpoint',
    );
  }

  // Step 3: Dynamic client registration (RFC 7591).
  //
  // Some providers (e.g. Datadog MCP) return a service_redirect_uri in the
  // DCR response — a provider-owned relay endpoint that MUST be the first
  // entry in redirect_uris for the authorization server to accept it. We
  // discover this URI in a probe registration, then re-register with
  // [service_redirect_uri, our_callback] so both are on record.
  const redirectUri = `${process.env.BACKEND_URL}/api/connectors/oauth/callback`;

  const makeDcrBody = (redirectUris: string[]) =>
    JSON.stringify({
      client_name: 'Liftoff',
      redirect_uris: redirectUris,
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    });

  logger.info({ provider, url: asData.registration_endpoint }, 'Registering OAuth client dynamically (probe)');
  const probeResponse = await fetchWithTimeout(asData.registration_endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: makeDcrBody([redirectUri]),
  });

  if (!probeResponse.ok) {
    const errorBody = await probeResponse.text().catch(() => 'no body');
    throw new OAuthDiscoveryError(
      `Dynamic registration failed: HTTP ${probeResponse.status} — ${errorBody}`,
      'registration_failed',
    );
  }

  const probeData = parseRegistrationResponse(await probeResponse.json(), asData.registration_endpoint);

  // If the probe revealed a service_redirect_uri, re-register with it first so
  // the provider's authorization server accepts it as a valid redirect_uri.
  let regData = probeData;
  if (probeData.service_redirect_uri && probeData.service_redirect_uri !== redirectUri) {
    logger.info(
      { provider, serviceRedirectUri: probeData.service_redirect_uri },
      'Provider returned service_redirect_uri — re-registering with relay URI first',
    );
    const reregResponse = await fetchWithTimeout(asData.registration_endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: makeDcrBody([probeData.service_redirect_uri, redirectUri]),
    });
    if (!reregResponse.ok) {
      const errorBody = await reregResponse.text().catch(() => 'no body');
      throw new OAuthDiscoveryError(
        `Dynamic re-registration failed: HTTP ${reregResponse.status} — ${errorBody}`,
        'registration_failed',
      );
    }
    regData = parseRegistrationResponse(await reregResponse.json(), asData.registration_endpoint);
  }


  logger.info(
    {
      provider,
      clientId: regData.client_id,
      hasRegistrationToken: !!regData.registration_access_token,
      hasServiceRedirectUri: !!regData.service_redirect_uri,
    },
    'Dynamic client registration successful',
  );

  // Step 4: Persist to DB (platform-level; bypass RLS)
  const row = await withAdminScope(
    { caller: 'oauth/discovery.discoverAndRegister', reason: 'RFC 7591 DCR persist' },
    async (client) => {
      const result = await client.query(
        `INSERT INTO oauth_dynamic_registrations
           (provider, client_id, authorization_endpoint, token_endpoint, registration_endpoint, redirect_uri, metadata)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (provider) DO UPDATE SET
           client_id = EXCLUDED.client_id,
           authorization_endpoint = EXCLUDED.authorization_endpoint,
           token_endpoint = EXCLUDED.token_endpoint,
           registration_endpoint = EXCLUDED.registration_endpoint,
           redirect_uri = EXCLUDED.redirect_uri,
           metadata = EXCLUDED.metadata,
           updated_at = NOW()
         RETURNING client_id, authorization_endpoint, token_endpoint`,
        [
          registrationKey,
          regData.client_id,
          asData.authorization_endpoint,
          asData.token_endpoint,
          asData.registration_endpoint,
          redirectUri,
          JSON.stringify({
            client_id_issued_at: regData.client_id_issued_at,
            client_secret_expires_at: regData.client_secret_expires_at,
            registration_client_uri: regData.registration_client_uri,
            service_redirect_uri: regData.service_redirect_uri,
            // registration_access_token goes to Secret Manager, not DB (SEC-017)
          }),
        ],
      );
      return result.rows[0];
    },
  );

  // Store registration_access_token in Secret Manager if present
  if (regData.registration_access_token) {
    const projectId = process.env.GCP_PROJECT_ID ?? process.env.GCP_PROJECT ?? 'YOUR_CONTROL_PROJECT_STAGING';
    // Secret IDs allow only [a-zA-Z0-9_-]; region keys (e.g. datadog@us3.datadoghq.com)
    // are sanitized so per-region registration tokens get distinct secrets.
    const secretId = `oauth-registration-token-${registrationKey.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
    const secretPath = `projects/${projectId}/secrets/${secretId}`;
    try {
      await secretManagerClient.getSecret({ name: secretPath }).catch(async (err: { code?: number }) => {
        if (err.code === 5) {
          await secretManagerClient.createSecret({
            parent: `projects/${projectId}`,
            secretId,
            secret: { replication: { automatic: {} } },
          });
        }
      });
      await secretManagerClient.addSecretVersion({
        parent: secretPath,
        payload: { data: Buffer.from(regData.registration_access_token) },
      });
      logger.info({ provider, secretId }, 'Registration access token stored in Secret Manager');
    } catch (err) {
      logger.warn(
        { provider, error: (err as Error).message },
        'Failed to store registration_access_token in Secret Manager',
      );
    }
  }

  const config: DiscoveredOAuthConfig = {
    authorizationEndpoint: row.authorization_endpoint,
    tokenEndpoint: row.token_endpoint,
    clientId: row.client_id,
    serviceRedirectUri: regData.service_redirect_uri,
  };
  discoveryCache.set(registrationKey, { config, cachedAt: Date.now() });
  return config;
}

interface DbRegistrationRow {
  client_id: string;
  authorization_endpoint: string;
  token_endpoint: string;
  updated_at: string;
  isStale: boolean;
  metadata?: Record<string, unknown>;
}

async function loadFromDb(provider: string): Promise<DbRegistrationRow | null> {
  return withAdminScope(
    { caller: 'oauth/discovery.loadFromDb', reason: 'DCR cache read' },
    async (client) => {
      const result = await client.query(
        `SELECT client_id, authorization_endpoint, token_endpoint, updated_at, metadata
           FROM oauth_dynamic_registrations
           WHERE provider = $1`,
        [provider],
      );
      if (result.rows.length === 0) return null;
      const row = result.rows[0];
      const updatedAt = new Date(row.updated_at).getTime();
      const isStale = Date.now() - updatedAt > REGISTRATION_TTL_MS;
      if (isStale) {
        logger.info(
          { provider, updatedAt: row.updated_at },
          'DB registration is stale, will attempt re-discovery (keeping as fallback)',
        );
      }
      return {
        client_id: row.client_id as string,
        authorization_endpoint: row.authorization_endpoint as string,
        token_endpoint: row.token_endpoint as string,
        updated_at: row.updated_at as string,
        metadata: row.metadata as Record<string, unknown> | undefined,
        isStale,
      };
    },
  );
}

function getDiscoveryBaseUrl(provider: string): string {
  const config = OAUTH_PROVIDER_CONFIGS[provider as OAuthProvider];
  if (!config || !isDiscoveryConfig(config)) {
    throw new OAuthDiscoveryError(
      `No discovery base URL configured for provider: ${provider}`,
      'no_base_url',
    );
  }
  return config.discoveryBaseUrl;
}

async function fetchWithTimeout(url: string, init?: RequestInit): Promise<Response> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } catch (error) {
    const err = error as { name?: string; message?: string };
    if (err.name === 'AbortError') {
      throw new OAuthDiscoveryError(`Discovery request timed out: ${url}`, 'timeout');
    }
    throw new OAuthDiscoveryError(
      `Discovery request failed: ${url} — ${err.message ?? 'unknown'}`,
      'network_error',
    );
  } finally {
    clearTimeout(timeout);
  }
}

// --- Error class ---

export class OAuthDiscoveryError extends Error {
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = 'OAuthDiscoveryError';
  }
}

// --- Startup validation (GAP-1) ---

/**
 * Validate all discovery-based OAuth configs have required fields.
 * Call at app startup to fail fast if NOTION_DISCOVERY etc. is misconfigured.
 */
export function validateDiscoveryConfigs(): void {
  for (const [provider, config] of Object.entries(OAUTH_PROVIDER_CONFIGS)) {
    if (isDiscoveryConfig(config)) {
      if (!config.discoveryBaseUrl) {
        throw new Error(`Discovery OAuth config for '${provider}' is missing discoveryBaseUrl`);
      }
      try {
        const parsed = new URL(config.discoveryBaseUrl);
        if (parsed.protocol !== 'https:') {
          throw new Error(
            `Discovery OAuth config for '${provider}' must use HTTPS: ${config.discoveryBaseUrl}`,
          );
        }
      } catch (err) {
        const message = (err as Error).message;
        if (message.includes('Discovery OAuth config')) throw err;
        throw new Error(
          `Discovery OAuth config for '${provider}' has invalid discoveryBaseUrl: ${config.discoveryBaseUrl}`,
        );
      }
    }
  }
}

// --- Test helpers ---

export function _resetCacheForTesting(): void {
  discoveryCache.clear();
  invalidationCooldowns.clear();
  authEndpointCache.clear();
  registrationLocks.clear();
}
