// Connector OAuth router.
//
// Ported from platform-backend/src/connectors/oauth-router.ts.
// Adapts:
//   - `log` → `logger` (infra/logging.ts)
//   - pool queries → withTenantScope (app.tenant_id) via connector-ops.ts
//   - Secret Manager storage → credentialService.storeCredentials
//     (connector-{tenantId}-{connectorId} naming in secrets/client.ts)
//   - Pub/Sub credential-stored event and the tenantService lookup are
//     NOT ported — the connector-service is the owner of credentials now,
//     so there is no tenant-runtime to notify. Legacy message remains in
//     platform-backend until Fix 6 completes (see PHASE1_DEPLOYMENT.md).
//   - Firebase auth (`req.user.uid`) is NOT ported — these routes sit
//     behind verifyServiceAuth (X-Service-Auth) in server.ts, and the
//     caller (platform-backend web tier) passes the canonical accountId
//     as a header `x-account-id`. The tenantId comes from `tenantId`
//     query / body param like before.
//   - hostingMode: `secrets/client.ts` resolves it from
//     TENANT_HOSTING_MODE env var — callers deploying into tenant
//     projects set it to 'dedicated'; shared runs stay 'shared'. No
//     per-request tenants-table lookup is needed here.
//
// Mount path: /api/connectors/oauth (see server.ts).

import { Router, Request, Response } from 'express';
import { SLACK_WORKSPACE_BOT_SCOPES } from '../types';
import crypto from 'node:crypto';
import { logger } from '../infra/logging.js';
import {
  ConnectorType,
  OAUTH_PROVIDER_CONFIGS,
  getOAuthProvider,
  getConnectorScopes,
  OAuthProvider,
  OAuthProviderConfig,
  DiscoveryOAuthConfig,
  isDiscoveryConfig,
  isStaticConfig,
  CONNECTOR_DISPLAY_NAMES,
} from '../types.js';
import {
  getDiscoveredOAuthConfig,
  fetchAuthorizationEndpointOnly,
  invalidateDiscoveredRegistration,
  fetchTokenEndpointOnly,
  OAuthDiscoveryError,
} from './discovery.js';
import {
  findConnectorByTenantAndType,
  findConnectorByTenantTypeAndExternalAccountId,
  findMigrationMarkedConnector,
  createConnector,
  updateConnectorStatus,
  createOAuthState,
  createComposioOAuthState,
  verifyOAuthState,
  peekOAuthState,
  deleteOAuthState,
  setMetaUserId,
  mergeConnectorConfig,
  adoptMigrationMarkedConnector,
  getConnectorById,
  createConnectorReusingOnAccountConflict,
} from './connector-ops.js';
import { fetchExternalIdentity } from './identity-fetchers.js';
import { buildIdentityConfig } from './identity-config.js';
import { CONNECTORS } from '../catalog/connectors.js';
import {
  linkComposioAccount,
  pollConnectedAccountActive,
  ComposioConnectionPendingError,
  type ComposioConnectedAccount,
} from './composio-client.js';
import { completeComposioConnection } from './composio-bind.js';
import { credentialService } from '../credentials/service.js';
import { registerStripeWebhook } from '../events/stripe-webhook-registration.js';
import { getConnectorCredential } from '../secrets/client.js';
import { withIdempotencyRest } from '../infra/idempotency-rest-middleware.js';
import { publishAuditEvent } from '../events/audit-publisher.js';
import { emitCredentialsStored } from '../events/publisher.js';
import { composioAuthConfigId, composioMcpServerId } from '../catalog/composio-resources';

// ──────────────────────────────────────────────────────────────────────
// DCR client override (local dev only)
// ──────────────────────────────────────────────────────────────────────

// A discovery (DCR) provider is supposed to register its own client at runtime
// per RFC 7591, and re-register once the stored one goes stale. That loop is the
// ONLY reason these providers survive a vendor expiring a client: the next
// connect attempt registers a fresh one and nobody notices.
//
// The clientIdEnvVar / clientSecretEnvVar on a DiscoveryOAuthConfig exist so a
// local checkout can borrow one hand-registered client instead of registering a
// throwaway on every boot. Honouring them in a DEPLOYED service silently turns
// DCR off for that provider: getDiscoveredOAuthConfig is never called, no row is
// ever written to oauth_dynamic_registrations, and the pinned client is used
// forever. When the vendor eventually forgets it, /authorize 401s
// `invalid_client` in the user's browser — and the invalidation below, which is
// the thing that would have healed it, never runs, because the flow dies before
// the token exchange it hangs off.
//
// So the override is honoured only OFF Cloud Run. K_SERVICE is injected by the
// Cloud Run runtime and is absent in a local process.
function discoveryClientOverride(config: DiscoveryOAuthConfig): {
  clientId?: string;
  clientSecret?: string;
} {
  if (process.env.K_SERVICE) return {};
  return {
    clientId: process.env[config.clientIdEnvVar],
    clientSecret: process.env[config.clientSecretEnvVar],
  };
}

// ──────────────────────────────────────────────────────────────────────
// PKCE helpers
// ──────────────────────────────────────────────────────────────────────

function generateCodeVerifier(): string {
  return crypto.randomBytes(32).toString('base64url');
}

function generateCodeChallenge(verifier: string): string {
  return crypto.createHash('sha256').update(verifier).digest('base64url');
}

function getAccountId(req: Request): string | null {
  const h = req.header('x-account-id');
  if (h && typeof h === 'string' && h.length > 0) return h;
  return null;
}

// Where a person lands when `FRONTEND_URL` is unset AND the caller supplied no
// explicit `returnUrl`. It was a hardcoded production host, on the reasoning
// that an unconfigured environment should land somewhere recognisable rather
// than on a literal `undefined/...`. That reasoning does not survive being
// deployed by somebody else: the person finishing an OAuth connection would be
// redirected onto an unrelated organisation's application, mid-flow, carrying
// whatever the callback put in the URL.
//
// A relative path keeps the original promise — never `undefined/...` — without
// naming a host. The browser resolves it against the origin it is already on,
// which is this deployment.
const FRONTEND_URL_FALLBACK = '/';

/**
 * Resolve the user-facing redirect URL. Used by both /start (when no
 * `returnUrl` body param) and /callback (when oauth_state.redirect_uri is
 * NULL — should never happen for fresh rows, but defensive).
 *
 * Order: explicit preferred URL > FRONTEND_URL env > hardcoded prod fallback.
 * Always returns a non-empty string; never produces `undefined/...`.
 */
function resolveFrontendRedirect(preferred?: string | null, path = '/dashboard/connections'): string {
  if (preferred && preferred.length > 0) return preferred;
  const base = process.env.FRONTEND_URL || FRONTEND_URL_FALLBACK;
  // Strip a trailing slash so `${base}/dashboard/...` doesn't double up.
  const trimmedBase = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${trimmedBase}${path}`;
}

/** Just the base URL — used for callback-error redirects to /oauth/callback. */
function resolveFrontendBase(): string {
  const base = process.env.FRONTEND_URL || FRONTEND_URL_FALLBACK;
  return base.endsWith('/') ? base.slice(0, -1) : base;
}

/**
 * Resolve the redirectUri the vendor OAuth provider should send the browser
 * back to (Liftoff's /callback endpoint). Throws when BACKEND_URL is unset —
 * letting `undefined/api/connectors/oauth/callback` reach the provider would
 * produce an invalid_redirect_uri error from the vendor with no clue what's
 * wrong. Failing at /start with a 500 is louder and easier to debug.
 */
function resolveBackendCallbackUrl(): string {
  const base = process.env.BACKEND_URL;
  if (!base) throw new Error('BACKEND_URL not configured');
  const trimmed = base.endsWith('/') ? base.slice(0, -1) : base;
  return `${trimmed}/api/connectors/oauth/callback`;
}

export const oauthRouter = Router();

// ──────────────────────────────────────────────────────────────────────
// POST /:connectorType/start
// ──────────────────────────────────────────────────────────────────────

oauthRouter.post('/:connectorType/start', withIdempotencyRest({ endpoint: 'POST /api/connectors/oauth/:connectorType/start' }), async (req: Request, res: Response) => {
  try {
    const { connectorType } = req.params;
    const { returnUrl, dynamicUrlParams } = req.body ?? {};
    // "Reconnect" on a specific card passes that connector row id; carried into
    // oauth_state so the callback reuses that exact row (Precedence tier-0).
    const reconnectConnectorId =
      typeof req.body?.connectorId === 'string' ? (req.body.connectorId as string) : undefined;
    const tenantId = (req.query.tenantId as string | undefined) ?? (req.body?.tenantId as string | undefined);

    // === NEW BRANCH: Composio-managed path ===
    // Branches BEFORE consulting OAUTH_PROVIDER_CONFIGS — the sentinel
    // COMPOSIO_MANAGED env-var values in the catalog entry would otherwise
    // surface as "OAuth client ID not configured" errors.
    const catalogEntry = CONNECTORS[connectorType];
    if (catalogEntry?.mcp?.kind === 'composio_managed') {
      if (!tenantId || typeof tenantId !== 'string') {
        return res.status(400).json({ error: 'tenantId is required' });
      }
      const accountId = getAccountId(req);
      if (!accountId) {
        return res.status(401).json({ error: 'Authentication required (x-account-id header)' });
      }
      // Strict-fail when no redirect target is known. Unlike the legacy
      // OAuth paths (which fall back to the hardcoded prod URL on errors),
      // the Composio path requires a concrete returnUrl up-front because
      // we ENCODE it on the oauth_state row and /callback uses it verbatim
      // when redirecting the browser. A silent fallback to the prod URL
      // would land users on the wrong deployment.
      if (!process.env.FRONTEND_URL && !returnUrl) {
        logger.error({ connectorType }, 'composio_start_missing_frontend_url');
        return res.status(500).json({ error: 'FRONTEND_URL not configured' });
      }
      // `frontendRedirectUri` is where /callback redirects the browser AFTER
      // it processes the Composio callback. It's stored on the oauth_state
      // row. NOT the URL we hand to Composio's `link()` — that one routes
      // back through Liftoff first (below) so /callback can complete the bind.
      const frontendRedirectUri = resolveFrontendRedirect(returnUrl);

      const env = (process.env.ENVIRONMENT ?? 'dev') as 'dev' | 'prod';
      if (env !== 'dev' && env !== 'prod') {
        logger.error({ env, connectorType }, 'composio_start_unsupported_env');
        return res.status(500).json({ error: `Unsupported ENVIRONMENT ${env}` });
      }
      // Prefer what this deployment's own bootstrap resolved over the ids
      // baked into the catalogue, which belong to one Composio organisation.
      const authConfigId = composioAuthConfigId(
        catalogEntry.mcp.toolkitSlug, catalogEntry.mcp.authConfigIds, env);
      const mcpServerId = composioMcpServerId(
        catalogEntry.mcp.toolkitSlug, catalogEntry.mcp.mcpServerIds, env);
      // Both IDs must be real before we let the user start an OAuth flow.
      // Letting /start succeed when only authConfigId is provisioned (e.g.
      // gong has a real ac_…, mcpServerIds are still `<from-phase-0>`)
      // would create a connector row at /callback that the tool gateway
      // can't actually use — mcp-server-registry marks it disabled, agent
      // tools 404. Refuse here so the user sees a "Coming soon" tile
      // instead of a connect-then-fail loop. Effective-status downgrade
      // in projections.ts already hides these from the picker; this is
      // belt-and-suspenders for direct API callers.
      if (!authConfigId || authConfigId.startsWith('<')) {
        logger.error(
          { connectorType, env },
          'composio_start_missing_auth_config_id',
        );
        return res.status(503).json({ error: 'Composio auth config not yet provisioned' });
      }
      if (!mcpServerId || mcpServerId.startsWith('<')) {
        logger.error(
          { connectorType, env },
          'composio_start_missing_mcp_server_id',
        );
        return res.status(503).json({ error: 'Composio MCP server not yet provisioned' });
      }

      // Generate the oauth_state row's `state` value up front (random, not
      // derived from Composio's link response) so we can include it in the
      // Composio callbackUrl. Composio doesn't propagate an arbitrary state
      // field, so we encode ours in the URL ourselves.
      const state = `cmp_${crypto.randomBytes(16).toString('hex')}`;

      // The callbackUrl is Liftoff's /callback (NOT the frontend) so /callback
      // can poll Composio, create the connector row, and then redirect the
      // browser to the frontend. Composio appends `?status=success` (or
      // `&status=failed`) to whatever URL we provide.
      let composioCallbackUrl: string;
      try {
        composioCallbackUrl = `${resolveBackendCallbackUrl()}?state=${encodeURIComponent(state)}`;
      } catch (err) {
        logger.error(
          { connectorType, err: (err as Error).message },
          'composio_start_missing_backend_url',
        );
        return res.status(500).json({ error: 'BACKEND_URL not configured' });
      }

      const { redirectUrl, connectedAccountId } = await linkComposioAccount({
        authConfigId,
        tenantId,
        callbackUrl: composioCallbackUrl,
      });

      // Persist the random state + the connectedAccountId Composio returned.
      // /callback's only inbound parameter is `state`; everything else
      // (tenantId, connectorType, the Composio id) comes from this row.
      await createComposioOAuthState({
        state,
        tenantId,
        accountId,
        connectorType: connectorType as ConnectorType,
        redirectUri: frontendRedirectUri,
        extra: {
          composioConnectedAccountId: connectedAccountId,
          composioAuthConfigId: authConfigId,
          ...(reconnectConnectorId ? { reconnectConnectorId } : {}),
        },
      });

      logger.info(
        { connectorType, tenantId, accountId, toolkitSlug: catalogEntry.mcp.toolkitSlug },
        'connector.composio_oauth_started',
      );

      return res.json({ authUrl: redirectUrl, state });
    }

    const provider = getOAuthProvider(connectorType as ConnectorType);
    if (!provider) {
      return res.status(400).json({ error: 'Unsupported connector type' });
    }

    const providerConfig = OAUTH_PROVIDER_CONFIGS[provider];

    if (!tenantId || typeof tenantId !== 'string') {
      return res.status(400).json({ error: 'tenantId is required' });
    }

    const accountId = getAccountId(req);
    if (!accountId) {
      return res.status(401).json({ error: 'Authentication required (x-account-id header)' });
    }

    const frontendRedirectUri = resolveFrontendRedirect(returnUrl);

    let clientId: string;
    let authBaseUrl: string;
    let forcesPkce = false;
    let dcrServiceRedirectUri: string | undefined;

    if (isDiscoveryConfig(providerConfig)) {
      const envClientId = discoveryClientOverride(providerConfig).clientId;
      if (envClientId) {
        // Local dev override (ignored on Cloud Run — see
        // discoveryClientOverride): use the pre-registered client ID from the
        // env var, but still discover the correct authorization_endpoint for
        // this specific vendor via well-known (no DCR registration, no DB access).
        clientId = envClientId;
        authBaseUrl = await fetchAuthorizationEndpointOnly(provider);
      } else {
        const discovered = await getDiscoveredOAuthConfig(provider);
        clientId = discovered.clientId;
        authBaseUrl = discovered.authorizationEndpoint;
        dcrServiceRedirectUri = discovered.serviceRedirectUri;
      }
      forcesPkce = true;
    } else {
      const envClientId = process.env[providerConfig.clientIdEnvVar];
      if (!envClientId) {
        logger.error(
          { provider, envVar: providerConfig.clientIdEnvVar },
          'OAuth client ID not configured',
        );
        return res.status(500).json({ error: 'OAuth not configured for this provider' });
      }
      clientId = envClientId;
      authBaseUrl = providerConfig.authUrl;
      // Substitute dynamic URL params (e.g. Zendesk subdomain)
      if (dynamicUrlParams && typeof dynamicUrlParams === 'object') {
        for (const [key, value] of Object.entries(dynamicUrlParams as Record<string, string>)) {
          authBaseUrl = authBaseUrl.replace(key.toUpperCase(), String(value));
        }
      }
    }

    const requiresPkce =
      forcesPkce || (isStaticConfig(providerConfig) && providerConfig.requiresPkce);
    const codeVerifier = requiresPkce ? generateCodeVerifier() : undefined;

    // Subdomain-scoped connectors (zendesk, bamboohr) pass { subdomain } as a dynamic URL
    // param. Persist it on the oauth_state (in `extra`) so the callback can reconstruct the
    // token URL + instanceUrl — NOT as an OAuth scope, since bamboohr's real scopes
    // legitimately contain ':' (e.g. employee:compensation).
    const dynSubdomain =
      dynamicUrlParams && typeof dynamicUrlParams === 'object'
        ? (dynamicUrlParams as Record<string, string>).subdomain
        : undefined;

    const oauthState = await createOAuthState(
      tenantId,
      accountId,
      connectorType as ConnectorType,
      frontendRedirectUri,
      codeVerifier,
      reconnectConnectorId,
      dynSubdomain,
    );

    // Copy so we never mutate the shared per-provider scope constant returned by getConnectorScopes.
    const scopes = [...getConnectorScopes(connectorType as ConnectorType)];

    const authUrl = buildAuthUrl(provider, providerConfig, {
      clientId,
      redirectUri: dcrServiceRedirectUri ?? resolveBackendCallbackUrl(),
      scopes,
      state: oauthState.state,
      codeChallenge: codeVerifier ? generateCodeChallenge(codeVerifier) : undefined,
      authBaseUrl,
    });

    logger.info(
      { connectorType, provider, tenantId, accountId },
      'connector.oauth_started',
    );

    return res.json({ authUrl, state: oauthState.state });
  } catch (error) {
    if (error instanceof OAuthDiscoveryError) {
      logger.error(
        { error: error.message, code: error.code },
        'OAuth discovery failed',
      );
      const status = error.code === 'discovery_cooldown' ? 503 : 500;
      return res.status(status).json({ error: 'discovery_failed', message: error.message });
    }
    logger.error({ error: (error as Error).message }, 'OAuth start failed');
    return res.status(500).json({ error: 'Failed to initiate OAuth flow' });
  }
});

// ──────────────────────────────────────────────────────────────────────
// GET /:connectorType/start — disabled (SE-003)
// ──────────────────────────────────────────────────────────────────────

oauthRouter.get('/:connectorType/start', (_req: Request, res: Response) => {
  logger.warn({}, 'Legacy GET OAuth start endpoint called — disabled per SE-003');
  return res.status(410).json({
    error: 'This endpoint has been disabled. Use POST /api/connectors/oauth/:connectorType/start instead.',
    migration: 'SE-003',
  });
});

// ──────────────────────────────────────────────────────────────────────
// buildAuthUrl — provider-specific param construction
// ──────────────────────────────────────────────────────────────────────

export function buildAuthUrl(
  provider: OAuthProvider,
  config: OAuthProviderConfig,
  params: {
    clientId: string;
    redirectUri: string;
    scopes: string[];
    state: string;
    codeChallenge?: string;
    authBaseUrl?: string;
  },
): string {
  const urlParams = new URLSearchParams({
    client_id: params.clientId,
    redirect_uri: params.redirectUri,
    state: params.state,
  });

  switch (provider) {
    case 'google':
      urlParams.set('response_type', 'code');
      urlParams.set('scope', params.scopes.join(' '));
      urlParams.set('access_type', 'offline');
      // `consent` forces the scope-grant screen so refresh tokens are
      // re-issued. `select_account` adds the account chooser so the user
      // can pick a Google identity other than whichever one their browser
      // happens to be signed into — required when the connecting account
      // (e.g. a work Gmail) differs from the user's everyday Google login.
      urlParams.set('prompt', 'consent select_account');
      break;
    case 'slack':
      // One consent, two grants: user_scope drives the connector's as-user
      // credential; scope installs the Liftoff app's bot into the workspace
      // (the callback hands the bot token to platform-backend — see
      // handoffSlackWorkspaceInstall).
      urlParams.set('user_scope', params.scopes.join(','));
      urlParams.set('scope', SLACK_WORKSPACE_BOT_SCOPES.join(','));
      break;
    case 'github':
      urlParams.set('scope', params.scopes.join(' '));
      break;
    case 'microsoft':
      urlParams.set('response_type', 'code');
      urlParams.set('scope', params.scopes.join(' '));
      urlParams.set('response_mode', 'query');
      break;
    case 'dropbox':
      urlParams.set('response_type', 'code');
      urlParams.set('token_access_type', 'offline');
      break;
    case 'box':
      urlParams.set('response_type', 'code');
      break;
    case 'zendesk':
      urlParams.set('response_type', 'code');
      urlParams.set('scope', params.scopes.join(' '));
      break;
    case 'bamboohr':
      // BambooHR authorize.php requires request=authorize + response_type=code. Scopes are
      // '+'-delimited — URLSearchParams encodes the space-join as '+', which BambooHR decodes
      // back. The subdomain sentinel is state-only (persisted in oauth_state.extra), never a scope.
      urlParams.set('request', 'authorize');
      urlParams.set('response_type', 'code');
      urlParams.set('scope', params.scopes.filter((s) => !s.startsWith('subdomain:')).join(' '));
      break;
    case 'atlassian':
      urlParams.set('response_type', 'code');
      urlParams.set('scope', params.scopes.join(' '));
      urlParams.set('audience', 'api.atlassian.com');
      urlParams.set('prompt', 'consent');
      break;
    case 'zoom':
      urlParams.set('response_type', 'code');
      break;
    case 'salesforce':
      urlParams.set('response_type', 'code');
      urlParams.set('scope', params.scopes.join(' '));
      urlParams.set('prompt', 'consent');
      break;
    case 'hubspot':
      urlParams.set('response_type', 'code');
      urlParams.set('scope', params.scopes.join(' '));
      if (params.codeChallenge) {
        urlParams.set('code_challenge', params.codeChallenge);
        urlParams.set('code_challenge_method', 'S256');
      }
      break;
    case 'intuit':
      urlParams.set('response_type', 'code');
      urlParams.set('scope', params.scopes.join(' '));
      break;
    case 'xero':
      urlParams.set('response_type', 'code');
      urlParams.set('scope', params.scopes.join(' '));
      if (params.codeChallenge) {
        urlParams.set('code_challenge', params.codeChallenge);
        urlParams.set('code_challenge_method', 'S256');
      }
      break;
    case 'notion':
      urlParams.set('response_type', 'code');
      urlParams.set('owner', 'user');
      if (params.codeChallenge) {
        urlParams.set('code_challenge', params.codeChallenge);
        urlParams.set('code_challenge_method', 'S256');
      }
      break;
    case 'asana':
      urlParams.set('response_type', 'code');
      // Asana MCP requires this extra parameter to scope the token to the MCP resource.
      urlParams.set('resource', 'https://mcp.asana.com/v2');
      if (params.codeChallenge) {
        urlParams.set('code_challenge', params.codeChallenge);
        urlParams.set('code_challenge_method', 'S256');
      }
      break;
    case 'attio':
    case 'linear':
    case 'calendly':
    case 'paypal':
    case 'granola':
      urlParams.set('response_type', 'code');
      if (params.codeChallenge) {
        urlParams.set('code_challenge', params.codeChallenge);
        urlParams.set('code_challenge_method', 'S256');
      }
      break;
    case 'stripe':
    case 'clay':
    case 'mesh':
    case 'pandadoc':
      // Clay.com (scope `mcp`) and Mesh (scopes `read`/`write`) require the OAuth
      // `scope` on the authorize request — Clay.com rejects authorize with a
      // generic "invalid parameters" page when scope is absent. PandaDoc is the
      // same shape: DCR + PKCE S256 + scope `read+write` (URLSearchParams encodes
      // the literal `+` as %2B, which the server decodes back to `read+write`).
      //
      // Stripe joined this family when it moved off Connect. Its own case
      // predated DCR and set response_type + scope with NO code_challenge, which
      // is how a live /start produced an authorize URL with `scope=read_write`
      // and no PKCE at all — against an authorization server advertising
      // `code_challenge_methods_supported: ["S256"]` and
      // `token_endpoint_auth_methods_supported: ["none"]`. A public client with
      // no PKCE is exactly what that combination must not allow.
      urlParams.set('response_type', 'code');
      urlParams.set('scope', params.scopes.join(' '));
      if (params.codeChallenge) {
        urlParams.set('code_challenge', params.codeChallenge);
        urlParams.set('code_challenge_method', 'S256');
      }
      break;
    case 'square':
      urlParams.set('response_type', 'code');
      urlParams.set('scope', params.scopes.join(' '));
      urlParams.set('session', 'false');
      break;
    case 'docusign':
      urlParams.set('response_type', 'code');
      urlParams.set('scope', params.scopes.join(' '));
      break;
    case 'outreach':
    case 'gong':
    case 'marketo':
      // salesloft left this group when it moved to DCR: its client is public and
      // its authorization server advertises S256, so it takes the default branch
      // (response_type, scope, PKCE) below.
      urlParams.set('response_type', 'code');
      urlParams.set('scope', params.scopes.join(' '));
      break;
    case 'meta':
      urlParams.set('response_type', 'code');
      urlParams.set('scope', params.scopes.join(','));
      urlParams.set('auth_type', 'rerequest');
      break;
    default:
      // Generic RFC 6749 authorization-code flow for any provider not explicitly
      // cased above — notably dcr_oauth / discovery connectors whose
      // authorization_endpoint comes from live metadata. `response_type` is
      // MANDATORY for the auth-code flow; without this branch a newly-added DCR
      // provider silently produced an authorize URL with only
      // client_id/redirect_uri/state, which vendors reject with "No authorization
      // response type provided" (observed for supermetrics/ahrefs/similarweb/
      // common_room). A vendor needing non-standard params still adds
      // its own case; this is the safe default, not a replacement for one.
      urlParams.set('response_type', 'code');
      if (params.scopes.length > 0) {
        urlParams.set('scope', params.scopes.join(' '));
      }
      if (params.codeChallenge) {
        urlParams.set('code_challenge', params.codeChallenge);
        urlParams.set('code_challenge_method', 'S256');
      }
      break;
  }

  const baseUrl = params.authBaseUrl || (isStaticConfig(config) ? config.authUrl : '');
  return `${baseUrl}?${urlParams.toString()}`;
}

// ──────────────────────────────────────────────────────────────────────
// GET /callback
// ──────────────────────────────────────────────────────────────────────

oauthRouter.get('/callback', async (req: Request, res: Response) => {
  try {
    const { code, state, error: oauthError } = req.query;

    if (oauthError) {
      logger.warn({ error: oauthError }, 'OAuth callback error from provider');
      const frontendUrl = resolveFrontendBase();
      return res.redirect(`${frontendUrl}/oauth/callback?error=oauth_denied`);
    }

    // Composio's callback doesn't carry a `code` (tokens stay with Composio).
    // Vendor-OAuth callbacks always do.
    const isComposioCallback = typeof state === 'string' && state.startsWith('cmp_');
    // A GitHub App INSTALL return carries no `code` either — the user token was
    // already obtained by the authorize leg that ran before the picker. It
    // carries `installation_id` + `setup_action` instead, or on the request path
    // only `setup_action=request`.
    const isGithubInstallCallback = typeof state === 'string' && state.startsWith('gha_');
    if (!state || (!isComposioCallback && !isGithubInstallCallback && !code)) {
      return res.status(400).json({ error: 'Missing code or state parameter' });
    }

    // OAuth-state lifecycle:
    //   Vendor OAuth path: consume-on-read via `verifyOAuthState` — the
    //     OAuth `code` can only be redeemed once at the IdP anyway, so
    //     consuming the row in the same query is safe and simple.
    //   Composio path:    peek (non-consuming) so a poll timeout doesn't
    //     burn the row. The browser can be refreshed and /callback will
    //     re-poll Composio against the same connected-account id. The row
    //     is explicitly deleted only after a TERMINAL Composio status.
    //     This prevents orphan ACTIVE rows in Composio that Liftoff can't
    //     reassociate on retry.
    const oauthState = isComposioCallback
      ? await peekOAuthState(state as string)
      : await verifyOAuthState(state as string);
    if (!oauthState) {
      logger.warn({ state }, 'Invalid or expired OAuth state');
      const frontendUrl = resolveFrontendBase();
      return res.redirect(`${frontendUrl}/oauth/callback?error=invalid_state`);
    }

    // === GitHub App install return ===
    //
    // Two outcomes, and GitHub tells us which. No guessing, no optimistic UI:
    //   setup_action=install + installation_id → they had permission
    //   setup_action=request, no installation_id → an owner must approve
    //
    // The request path is why `githubTargetLogin` was stored at /install-start:
    // GitHub sends no organization name here, so without it the pending card
    // could not say what it is waiting on and the later `installation.created`
    // webhook would have nothing to match against.
    if (isGithubInstallCallback) {
      const { completeGithubAppInstallation, recordPendingInstallRequest } = await import(
        './github-app-bind.js'
      );
      const { readInstallStateExtra } = await import('./github-app-install-router.js');
      const targetLogin = readInstallStateExtra(oauthState).githubTargetLogin ?? '';
      const redirectUri = resolveFrontendRedirect(oauthState.redirectUri);
      const installationId = Number(req.query.installation_id ?? 0);
      const setupAction = String(req.query.setup_action ?? '');

      if (setupAction === 'request' || !installationId) {
        const connectorId = await recordPendingInstallRequest({
          tenantId: oauthState.tenantId,
          orgLogin: targetLogin,
        });
        logger.info(
          { tenantId: oauthState.tenantId, org: targetLogin },
          'github_app_install_pending_org_approval',
        );
        return res.redirect(
          `${redirectUri}?pending=github&org=${encodeURIComponent(targetLogin)}&connectorId=${connectorId}`,
        );
      }

      const completed = await completeGithubAppInstallation({
        installationId,
        tenantId: oauthState.tenantId,
        source: 'callback',
      });
      if (!completed) {
        return res.redirect(`${redirectUri}?error=github_install_failed`);
      }
      return res.redirect(
        `${redirectUri}?connected=github&connectorId=${completed.connectorId}`,
      );
    }

    // === NEW BRANCH: Composio callback ===
    if (isComposioCallback) {
      const extra = (oauthState.extra ?? {}) as {
        composioConnectedAccountId?: string;
        composioAuthConfigId?: string;
      };
      const connectedAccountId = extra.composioConnectedAccountId;
      const composioAuthConfigId = extra.composioAuthConfigId;
      if (!connectedAccountId || !composioAuthConfigId) {
        logger.error({ state }, 'composio callback missing extra payload');
        // Terminal corruption — delete the row so it can't be retried.
        await deleteOAuthState(state as string);
        const redirectUri =
          resolveFrontendRedirect(oauthState.redirectUri);
        return res.redirect(`${redirectUri}?error=composio_link_failed`);
      }

      let connectedAccount: ComposioConnectedAccount;
      try {
        connectedAccount = await pollConnectedAccountActive(connectedAccountId);
      } catch (err) {
        // Two flavors of failure here:
        //   (a) Pending timeout: ConnectionRequest is still INITIATED.
        //       Composio MAY flip it ACTIVE later. We KEEP the oauth_state
        //       row alive so a browser refresh re-fires /callback and
        //       polls again — this is the orphan-prevention design.
        //   (b) Terminal failure (FAILED/EXPIRED/REVOKED): the
        //       connection is dead in Composio. We delete the state row
        //       since there's nothing left to recover.
        if (err instanceof ComposioConnectionPendingError) {
          logger.error(
            {
              connectedAccountId: err.connectedAccountId,
              lastStatus: err.lastStatus,
              connectorType: oauthState.connectorType,
              tenantId: oauthState.tenantId,
              state,
            },
            'composio_link_pending_at_deadline_oauth_state_retained_for_retry',
          );
        } else {
          logger.error(
            { err: (err as Error).message, connectorType: oauthState.connectorType },
            'composio_link_failed',
          );
          await deleteOAuthState(state as string);
        }
        const redirectUri =
          resolveFrontendRedirect(oauthState.redirectUri);
        return res.redirect(`${redirectUri}?error=composio_link_failed`);
      }

      // The bind lives in composio-bind.ts because the reconciler runs the
      // identical completion when the browser never comes back. Do not
      // reimplement any of it here — see that file's header for why.
      const { connectorId } = await completeComposioConnection({
        state: state as string,
        oauthState,
        connectedAccount,
        composioAuthConfigId,
        source: 'callback',
      });

      const redirectUri = resolveFrontendRedirect(oauthState.redirectUri);
      return res.redirect(
        `${redirectUri}?connected=${oauthState.connectorType}&connectorId=${connectorId}`,
      );
    }

    const provider = getOAuthProvider(oauthState.connectorType);
    if (!provider) {
      logger.error(
        { connectorType: oauthState.connectorType },
        'Unknown OAuth provider for connector type',
      );
      const frontendUrl = resolveFrontendBase();
      return res.redirect(`${frontendUrl}/oauth/callback?error=callback_failed`);
    }

    const providerConfig = OAUTH_PROVIDER_CONFIGS[provider];

    let clientId: string | undefined;
    let clientSecret: string | undefined;
    let tokenUrl: string;

    let callbackServiceRedirectUri: string | undefined;

    if (isDiscoveryConfig(providerConfig)) {
      const override = discoveryClientOverride(providerConfig);
      if (override.clientId) {
        clientId = override.clientId;
        clientSecret = override.clientSecret;
        tokenUrl = await fetchTokenEndpointOnly(provider);
      } else {
        const discovered = await getDiscoveredOAuthConfig(provider);
        clientId = discovered.clientId;
        clientSecret = undefined;
        tokenUrl = discovered.tokenEndpoint;
        callbackServiceRedirectUri = discovered.serviceRedirectUri;
      }
    } else {
      clientId = process.env[providerConfig.clientIdEnvVar];
      clientSecret = process.env[providerConfig.clientSecretEnvVar];
      tokenUrl = providerConfig.tokenUrl;

      // Subdomain-scoped connectors (zendesk, bamboohr): substitute the SUBDOMAIN placeholder in
      // the token URL from the subdomain persisted on the oauth_state (extra) at /start.
      const stateSubdomain = (oauthState.extra as Record<string, unknown> | null)?.subdomain;
      if (typeof stateSubdomain === 'string' && stateSubdomain) {
        tokenUrl = tokenUrl.replace('SUBDOMAIN', stateSubdomain);
      }

      if (!clientId || !clientSecret) {
        logger.error(
          {
            provider,
            clientIdEnvVar: providerConfig.clientIdEnvVar,
            clientSecretEnvVar: providerConfig.clientSecretEnvVar,
            hasClientId: !!clientId,
            hasClientSecret: !!clientSecret,
          },
          'OAuth credentials missing',
        );
        const frontendUrl = resolveFrontendBase();
        return res.redirect(`${frontendUrl}/dashboard/connections?error=oauth_not_configured`);
      }
    }

    logger.info(
      { provider, connectorType: oauthState.connectorType },
      'Exchanging OAuth code for tokens',
    );

    const isPublicClient =
      isDiscoveryConfig(providerConfig) && !discoveryClientOverride(providerConfig).clientId;
    const tokenData = await exchangeCodeForTokens(provider, providerConfig, {
      code: code as string,
      clientId: clientId!,
      clientSecret: clientSecret ?? '',
      redirectUri: callbackServiceRedirectUri ?? resolveBackendCallbackUrl(),
      codeVerifier: oauthState.codeVerifier ?? undefined,
      isPublicClient,
      tokenUrl,
    });

    if (tokenData.error) {
      logger.error(
        { error: tokenData.error, description: tokenData.error_description },
        'Token exchange failed',
      );

      if (tokenData.error === 'invalid_client' && isDiscoveryConfig(providerConfig)) {
        logger.warn(
          { provider },
          'invalid_client from discovery provider — invalidating registration',
        );
        await invalidateDiscoveredRegistration(provider).catch((err) =>
          logger.error({ error: (err as Error).message }, 'Failed to invalidate registration'),
        );
      }

      const redirectUri =
        resolveFrontendRedirect(oauthState.redirectUri);
      return res.redirect(`${redirectUri}?error=token_exchange_failed`);
    }

    if (!tokenData.access_token) {
      logger.error({ tokenData: JSON.stringify(tokenData) }, 'No access token in response');
      const redirectUri =
        resolveFrontendRedirect(oauthState.redirectUri);
      return res.redirect(`${redirectUri}?error=no_access_token`);
    }

    logger.info(
      { provider, hasRefreshToken: !!tokenData.refresh_token },
      'Token exchange successful',
    );

    // Per-provider identity fetch BEFORE find-or-create.
    // Every provider in identity-fetchers.ts returns { externalAccountId,
    // externalAccountLabel }. The id is the lookup key (so a SECOND OAuth
    // for a DIFFERENT account on the same connector type creates a fresh
    // row instead of overwriting), the label is what the UI renders as
    // the Connected card subtitle. Providers without a fetcher fall back
    // to legacy single-instance behavior.
    //
    // Some providers need extras (Salesforce: instance_url from the token
    // response; Zendesk: subdomain from oauthState). Pass them through.
    const identityExtras: { instanceUrl?: string; subdomain?: string; connectorType?: string } = {
      connectorType: oauthState.connectorType,
    };
    const instanceUrlFromToken = (tokenData as { instance_url?: string }).instance_url;
    if (instanceUrlFromToken) identityExtras.instanceUrl = instanceUrlFromToken;
    // (subdomain would come from oauthState when we add it for Zendesk;
    // unsupported for now, fetcher returns null without it.)
    const identity = await fetchExternalIdentity(
      provider,
      tokenData.access_token,
      identityExtras,
    );
    if (identity) {
      logger.info(
        { provider, externalAccountId: identity.externalAccountId, externalAccountLabel: identity.externalAccountLabel },
        'identity fetched',
      );
    }

    // Find or create connector — Precedence (identity-authoritative):
    //   identity → dedup by externalAccountId; adopt an un-claimed reconnect
    //   target (heal); else new row. No identity → reconnect target reuse,
    //   else legacy (tenant, type) single-instance.
    const reconnectId =
      (oauthState.extra as { reconnectConnectorId?: string } | null)?.reconnectConnectorId;
    let connector: Awaited<ReturnType<typeof getConnectorById>> = null;
    if (identity) {
      connector = await findConnectorByTenantTypeAndExternalAccountId(
        oauthState.tenantId,
        oauthState.connectorType,
        identity.externalAccountId,
      );
      if (!connector && reconnectId) {
        const t = await getConnectorById(oauthState.tenantId, reconnectId);
        if (
          t &&
          t.type === oauthState.connectorType &&
          // Adoptable when the row never had an identity, OR when it was
          // explicitly marked for forced reconnect (source flip): its stored
          // externalAccountId belongs to the OLD dispatch source (e.g. a
          // Composio connected-account id) and can never equal the new
          // source's identity, so requiring it to be absent would make every
          // cross-source reconnect create a sibling row and orphan the id the
          // tenant runtime's manifests and tool aliases are bound to.
          (
            !(t.config as { externalAccountId?: string }).externalAccountId ||
            ((t.status === 'error' || t.status === 'disconnected') &&
              (t.config as { disconnect_reason?: string }).disconnect_reason)
          )
        ) {
          connector = t;
          try {
            await mergeConnectorConfig(oauthState.tenantId, t.id, buildIdentityConfig(provider, identity, { scopes: oauthState.scopes }));
          } catch (err) {
            if ((err as { code?: string }).code === '23505') {
              const dup = await findConnectorByTenantTypeAndExternalAccountId(
                oauthState.tenantId,
                oauthState.connectorType,
                identity.externalAccountId,
              );
              if (dup) connector = dup;
            } else {
              throw err;
            }
          }
        }
      }
      if (!connector) {
        // Source-flip heal (mirrors the Composio branch): adopt the row an
        // operator marked for forced reconnect instead of creating a sibling.
        // Adopting keeps the connector id, so TR manifests + agent tool-name
        // aliases survive.
        const marked = await findMigrationMarkedConnector(
          oauthState.tenantId,
          oauthState.connectorType,
        );
        if (marked) {
          connector = marked;
          try {
            // REPLACE, not merge — the same reason adoptMigrationMarkedConnector
            // gives on the Composio branch, which this heal is supposed to
            // mirror: a migration-marked row carries the state it is being
            // migrated AWAY from, and that must not bleed into the new binding.
            //
            // Merging here breaks a composio→native revert. It leaves
            // `composioConnectedAccountId` in the config, and makeConnectorTransport
            // selects the Composio proxy on the mere PRESENCE of that field. So a
            // connector that has just been rebound to Liftoff's own Slack app goes
            // on dispatching through Composio — to the connected account the
            // migration deleted. Every send comes back
            // `404 ConnectedAccount_ResourceNotFound`, silently.
            //
            // The two branches doing the same heal two different ways is the
            // defect; this makes the native one agree.
            connector = await adoptMigrationMarkedConnector(
              oauthState.tenantId,
              marked.id,
              buildIdentityConfig(provider, identity, { scopes: oauthState.scopes }),
            );
          } catch (err) {
            if ((err as { code?: string }).code === '23505') {
              const dup = await findConnectorByTenantTypeAndExternalAccountId(
                oauthState.tenantId,
                oauthState.connectorType,
                identity.externalAccountId,
              );
              if (dup) connector = dup;
            } else {
              throw err;
            }
          }
        }
      }
      if (!connector) {
        connector = await createConnectorReusingOnAccountConflict(
          {
            tenantId: oauthState.tenantId,
            type: oauthState.connectorType,
            name: CONNECTOR_DISPLAY_NAMES[oauthState.connectorType] ?? oauthState.connectorType,
            config: buildIdentityConfig(provider, identity, { scopes: oauthState.scopes }),
          },
          identity.externalAccountId,
        );
      }
    } else {
      connector = reconnectId
        ? await getConnectorById(oauthState.tenantId, reconnectId)
        : await findConnectorByTenantAndType(oauthState.tenantId, oauthState.connectorType);
      if (!connector) {
        connector = await createConnector({
          tenantId: oauthState.tenantId,
          type: oauthState.connectorType,
          name: CONNECTOR_DISPLAY_NAMES[oauthState.connectorType] ?? oauthState.connectorType,
        });
      }
    }
    // Reused/adopted rows return to pending during the callback (fresh creates
    // are already pending); also re-narrows `connector` to non-null.
    connector = await updateConnectorStatus(oauthState.tenantId, connector.id, 'pending');
    logger.info(
      {
        connectorId: connector.id,
        ...(identity ? { externalAccountLabel: identity.externalAccountLabel } : {}),
      },
      'connector.oauth_find_or_create',
    );

    // Defense-in-depth backfill: if the row exists from before this code
    // landed (config has no externalAccountId/Label yet) and we have an
    // identity now, write it. Synchronous so it's durable before redirect —
    // Cloud Run terminates the container shortly after the response.
    if (identity) {
      const cfg = (connector.config ?? {}) as {
        externalAccountId?: string;
        externalAccountLabel?: string;
        bot_login?: string;
      };
      const desired = buildIdentityConfig(provider, identity, { scopes: oauthState.scopes });
      if (
        cfg.externalAccountId !== identity.externalAccountId ||
        cfg.externalAccountLabel !== identity.externalAccountLabel ||
        // github rows created before bot_login was recorded get it backfilled here.
        (desired.bot_login !== undefined && !cfg.bot_login)
      ) {
        await mergeConnectorConfig(oauthState.tenantId, connector.id, desired);
      }
    }

    const expiresAt = tokenData.expires_in
      ? new Date(Date.now() + tokenData.expires_in * 1000)
      : undefined;

    // Metadata for discovery-based providers so the refresh handler can
    // re-use tokenEndpoint / clientId without a second discovery call.
    let credentialMetadata: Record<string, unknown> | undefined;
    if (isDiscoveryConfig(providerConfig) && !discoveryClientOverride(providerConfig).clientId) {
      try {
        const discovered = await getDiscoveredOAuthConfig(provider);
        credentialMetadata = {
          oauthDiscovery: true,
          tokenEndpoint: discovered.tokenEndpoint,
          clientId: discovered.clientId,
        };
      } catch (err) {
        logger.warn(
          { error: (err as Error).message },
          'Failed to load discovery metadata for credential storage',
        );
      }
    }

    const flowKind =
      isDiscoveryConfig(providerConfig) && !discoveryClientOverride(providerConfig).clientId
        ? 'dynamic_client_registration'
        : 'static_oauth';

    // For subdomain-scoped connectors (zendesk, bamboohr), derive instanceUrl so the native
    // client can build the per-company API base (bamboohr: https://{sub}.bamboohr.com/api/v1).
    let derivedInstanceUrl: string | undefined = tokenData.instance_url;
    // BambooHR's token response returns the AUTHORITATIVE company domain — prefer it over the
    // user-typed subdomain so the API base is correct even if the user entered a display alias.
    if (!derivedInstanceUrl && oauthState.connectorType === 'bamboohr' && tokenData.companyDomain) {
      derivedInstanceUrl = tokenData.companyDomain.includes('.')
        ? `https://${tokenData.companyDomain}`
        : `https://${tokenData.companyDomain}.bamboohr.com`;
    }
    if (!derivedInstanceUrl) {
      const stateSubdomain = (oauthState.extra as Record<string, unknown> | null)?.subdomain;
      if (typeof stateSubdomain === 'string' && stateSubdomain) {
        const host = oauthState.connectorType === 'bamboohr' ? 'bamboohr.com' : 'zendesk.com';
        derivedInstanceUrl = `https://${stateSubdomain}.${host}`;
      }
    }
    // Native HRIS OAuth (gusto/rippling): persist the connected company id (from the
    // identity fetch) as credential.instanceUrl. The gusto client reads it as the
    // company_id for company-scoped endpoints; it also disambiguates multi-company
    // connections. No-op for every other provider (identity is null or unused here).
    if ((provider === 'gusto' || provider === 'rippling') && identity?.externalAccountId) {
      derivedInstanceUrl = identity.externalAccountId;
    }

    // Carry over the existing refresh_token if the provider didn't return a new one.
    // Google only issues refresh_tokens on first authorization. On a repeat-auth
    // reconnect it returns only an access_token; preserving the prior refresh_token
    // keeps the credential service able to auto-refresh after the access_token expires.
    let refreshToken: string | undefined = tokenData.refresh_token;
    if (!refreshToken) {
      try {
        const existing = await getConnectorCredential(oauthState.tenantId, connector.id);
        if (existing?.refreshToken) {
          refreshToken = existing.refreshToken;
          logger.info(
            { connectorId: connector.id, provider },
            'Carrying over existing refresh_token (provider did not return a new one)',
          );
        }
      } catch {
        // Secret not found — first connect or post-full-disconnect reconnect.
        // In those cases the provider always returns a fresh refresh_token anyway.
      }
    }

    // Stripe: register this tenant's webhook endpoint on their own account and
    // keep the signing secret with the credential. Stripe has no modified-since
    // filter on any list, so without this the connector can only ever see
    // creations. Registration must not be able to fail the connection — it
    // returns null and the connector degrades to poll-only, loudly logged.
    let stripeWebhookSecret: string | null = null;
    if (oauthState.connectorType === 'stripe' && tokenData.access_token) {
      stripeWebhookSecret = await registerStripeWebhook({
        tenantId: oauthState.tenantId,
        connectorId: connector.id,
        accessToken: tokenData.access_token,
      });
    }

    try {
      await credentialService.storeCredentials(
        oauthState.tenantId,
        connector.id,
        flowKind,
        {
          accessToken: tokenData.access_token,
          refreshToken: refreshToken,
          expiresAt: expiresAt ? expiresAt.toISOString() : undefined,
          scopes: oauthState.scopes ?? [],
          instanceUrl: derivedInstanceUrl,
          metadata: stripeWebhookSecret
            ? { ...(credentialMetadata ?? {}), webhookSigningSecret: stripeWebhookSecret }
            : credentialMetadata,
        },
        oauthState.scopes ?? [],
      );
    } catch (storeErr) {
      // Mark connector as error so it doesn't dangle in 'pending' state.
      // The user will be prompted to reconnect rather than seeing a broken connector.
      logger.error(
        { connectorId: connector.id, tenantId: oauthState.tenantId, err: (storeErr as Error).message },
        'Failed to store credentials after OAuth — marking connector error',
      );
      await updateConnectorStatus(oauthState.tenantId, connector.id, 'error').catch(() => undefined);
      const redirectUri = resolveFrontendRedirect(oauthState.redirectUri);
      return res.redirect(`${redirectUri}?error=credential_store_failed`);
    }

    // Flip connector status to active now that credentials exist.
    await updateConnectorStatus(oauthState.tenantId, connector.id, 'active');

    // Slack dual grant: the exchange also returned the workspace BOT token
    // (bot installed by the same consent). Hand it to platform-backend, which
    // owns slack_workspace_installs (agent chat, HITL cards, slack_* bot
    // tools). Best-effort + awaited: Cloud Run cpu-throttling starves
    // fire-and-forget work after the redirect, and a failure must not break
    // the connector connect (Reconnect re-delivers).
    if (
      oauthState.connectorType === 'slack' &&
      tokenData.slack_bot_access_token &&
      tokenData.bot_user_id &&
      (tokenData.team?.id || identity?.externalAccountId)
    ) {
      const { handoffSlackWorkspaceInstall } = await import('./slack-workspace-handoff.js');
      await handoffSlackWorkspaceInstall({
        tenantId: oauthState.tenantId,
        slackTeamId: tokenData.team?.id ?? identity!.externalAccountId,
        slackTeamName: tokenData.team?.name ?? identity?.externalAccountLabel ?? null,
        slackBotUserId: tokenData.bot_user_id,
        botToken: tokenData.slack_bot_access_token,
        installedByAccountId: oauthState.accountId ?? null,
      });
    }

    logger.info(
      {
        connectorId: connector.id,
        connectorType: oauthState.connectorType,
        provider,
        tenantId: oauthState.tenantId,
        accountId: oauthState.accountId,
      },
      'connector.oauth_completed',
    );

    // Workspace-visible audit: a connector OAuth callback successfully
    // completed. Skip if the original /start call didn't carry an accountId
    // (defensive — every flow should have one).
    if (oauthState.accountId) {
      try {
        const identityCfg = (connector.config ?? {}) as {
          externalAccountId?: string;
          externalAccountLabel?: string;
        };
        await publishAuditEvent({
          tenantId: oauthState.tenantId,
          userId: oauthState.accountId,
          eventType: 'connector.reauthorized',
          resourceId: connector.id,
          newState: {
            connectorId: connector.id,
            connectorType: oauthState.connectorType,
            externalAccountId: identityCfg.externalAccountId,
            externalAccountLabel: identityCfg.externalAccountLabel,
          },
        });
      } catch (err) {
        logger.warn(
          { err, connectorId: connector.id },
          'audit publish (connector.reauthorized) failed',
        );
      }
    }

    // Fire-and-forget cross-service signal so platform-backend can
    // resolve any `pending_integrations` entries on this connector type.
    // Must never block or fail the OAuth callback: emitCredentialsStored
    // returns immediately and swallows any eventual publisher error.
    emitCredentialsStored({
      tenantId: oauthState.tenantId,
      connectorId: connector.id,
      connectorType: oauthState.connectorType,
    });

    if (oauthState.connectorType === 'meta_ads') {
      void (async () => {
        try {
          const meResp = await fetch(
            `https://graph.facebook.com/v21.0/me?fields=id&access_token=${encodeURIComponent(tokenData.access_token ?? '')}`,
          );
          if (meResp.ok) {
            const me = (await meResp.json()) as { id?: string };
            if (me.id) {
              await setMetaUserId(oauthState.tenantId, connector.id, me.id);
            }
          }
        } catch (err) {
          logger.warn({ error: (err as Error).message }, 'meta_ads: failed to store meta_user_id');
        }
      })();
    }

    // google_mail's config.email is written synchronously above (during
    // find-or-create) so Cloud Run can't drop it before redirect.

    const redirectUri =
      resolveFrontendRedirect(oauthState.redirectUri);
    return res.redirect(
      `${redirectUri}?connected=${oauthState.connectorType}&connectorId=${connector.id}`,
    );
  } catch (error) {
    const err = error as Error;
    logger.error(
      { error: err.message, stack: err.stack, name: err.name },
      'OAuth callback failed',
    );
    const frontendUrl = resolveFrontendBase();
    return res.redirect(`${frontendUrl}/oauth/callback?error=callback_failed`);
  }
});

// ──────────────────────────────────────────────────────────────────────
// exchangeCodeForTokens — provider-specific token exchange
// ──────────────────────────────────────────────────────────────────────

export interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
  ok?: boolean;
  authed_user?: {
    id: string;
    access_token: string;
    token_type: string;
    scope: string;
  };
  // Slack: bot-token half of the dual-grant exchange (top-level access_token
  // is the xoxb bot token until the fixup below swaps in the user token).
  bot_user_id?: string;
  team?: { id?: string; name?: string };
  slack_bot_access_token?: string;
  stripe_user_id?: string;
  stripe_publishable_key?: string;
  instance_url?: string;
  // BambooHR's token.php response returns the authoritative company subdomain.
  companyDomain?: string;
  id?: string;
  issued_at?: string;
}

export async function exchangeCodeForTokens(
  provider: OAuthProvider,
  config: OAuthProviderConfig,
  params: {
    code: string;
    clientId: string;
    clientSecret: string;
    redirectUri: string;
    codeVerifier?: string;
    isPublicClient?: boolean;
    tokenUrl?: string;
  },
): Promise<TokenResponse> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/x-www-form-urlencoded',
  };

  if (provider === 'github') {
    headers.Accept = 'application/json';
  }

  if (provider === 'box') {
    const basicAuth = Buffer.from(`${params.clientId}:${params.clientSecret}`).toString('base64');
    headers.Authorization = `Basic ${basicAuth}`;
  }

  const body = new URLSearchParams({
    code: params.code,
    redirect_uri: params.redirectUri,
    grant_type: 'authorization_code',
  });

  if (params.isPublicClient) {
    body.set('client_id', params.clientId);
  } else if (provider !== 'box') {
    body.set('client_id', params.clientId);
    body.set('client_secret', params.clientSecret);
  }

  if (params.codeVerifier) {
    body.set('code_verifier', params.codeVerifier);
  }

  const effectiveTokenUrl = params.tokenUrl || (isStaticConfig(config) ? config.tokenUrl : '');
  const response = await fetch(effectiveTokenUrl, {
    method: 'POST',
    headers,
    body,
  });

  const data = (await response.json()) as TokenResponse;

  // Provider-specific expiry fixups (same logic as platform-backend source)
  if (provider === 'github' && data.access_token && !data.expires_in) {
    data.expires_in = 365 * 24 * 60 * 60;
  }
  if (provider === 'dropbox' && data.access_token && !data.expires_in) {
    data.expires_in = 4 * 60 * 60;
  }
  if (provider === 'slack' && data.authed_user?.access_token) {
    // Preserve the bot token before the connector-credential swap: Slack's
    // oauth.v2.access puts the xoxb BOT token in access_token and the user
    // token under authed_user. The connector credential is the user token;
    // the bot token is handed to platform-backend after the connector row
    // settles (workspace install).
    if (data.access_token && data.access_token !== data.authed_user.access_token) {
      data.slack_bot_access_token = data.access_token;
    }
    data.access_token = data.authed_user.access_token;
    data.expires_in = 365 * 24 * 60 * 60;
  }
  if (provider === 'slack' && data.ok === false && !data.error) {
    data.error = 'slack_oauth_failed';
  }
  if (provider === 'stripe' && data.access_token && !data.expires_in) {
    data.expires_in = 365 * 24 * 60 * 60;
  }
  if (provider === 'atlassian' && data.access_token && !data.expires_in) {
    data.expires_in = 60 * 60;
  }
  if (provider === 'salesforce' && data.access_token && !data.expires_in) {
    data.expires_in = 2 * 60 * 60;
  }
  if (provider === 'hubspot' && data.access_token && !data.expires_in) {
    data.expires_in = 30 * 60;
  }
  if (provider === 'notion' && data.access_token && !data.expires_in) {
    data.expires_in = 60 * 60;
  }
  if (provider === 'intuit' && data.access_token && !data.expires_in) {
    data.expires_in = 60 * 60;
  }
  if (provider === 'xero' && data.access_token && !data.expires_in) {
    data.expires_in = 30 * 60;
  }
  if (provider === 'paypal' && !data.access_token && !data.error) {
    data.expires_in = 8 * 60 * 60;
  }

  // Meta: standard POST gives a short-lived token; upgrade to 60-day long-lived token.
  // Store access_token as refresh_token so the standard renewal cycle can re-exchange it.
  if (provider === 'meta' && data.access_token) {
    const longLivedResp = await fetch(
      `https://graph.facebook.com/oauth/access_token?` +
      new URLSearchParams({
        grant_type: 'fb_exchange_token',
        client_id: params.clientId,
        client_secret: params.clientSecret,
        fb_exchange_token: data.access_token,
      }),
    );
    const longLived = (await longLivedResp.json()) as { access_token?: string; expires_in?: number };
    if (longLived.access_token) {
      data.access_token = longLived.access_token;
      data.refresh_token = longLived.access_token;
      data.expires_in = longLived.expires_in ?? 5184000;
    } else {
      // fb_exchange_token failed (Meta returned an error body). The short-lived token is
      // stored with no refresh_token, so the renewal cycle will never fire and the
      // connector will silently stop working when the token expires (~1 hour).
      logger.warn(
        { provider: 'meta', status: longLivedResp.status },
        'meta: fb_exchange_token upgrade failed — connector stored with short-lived token only',
      );
    }
  }

  return data;
}
