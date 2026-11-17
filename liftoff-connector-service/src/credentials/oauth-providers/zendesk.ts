// Zendesk OAuth refresh handler.
//
// Zendesk is subdomain-scoped: every tenant's token endpoint is
// `https://<subdomain>.zendesk.com/oauth/tokens`. The subdomain is
// stored in the connector record's config or the credential's
// instance_url. We extract it from `args.scopes` via a no-op (scopes
// don't carry subdomain) — instead, the caller must record the
// instance URL in the `extra` column of `connector_credentials`, which
// reaches us via the OAuthRefreshHandlerArgs as `args.scopes` OR we
// must accept that the platform backend fills `instance_url` into the
// stored secret data. Because the refresh handler runs against the
// CURRENT secret's refresh_token, we fall back to reading the stored
// secret's `instanceUrl` field if needed.
//
// For now, require the subdomain to come in via a connector-scoped env
// var `ZENDESK_SUBDOMAIN_OVERRIDE` (dev) or the stored secret's
// instance_url. This function only receives refreshToken; the stored
// secret is fetched by the caller before dispatch, so we enforce that
// the caller already embedded instanceUrl — pass via per-request
// handler args extension.
//
// SIMPLIFIED: Zendesk is subdomain-scoped but the subdomain is owned by
// the connector row in `connectors.config.subdomain`. The credential
// service passes scopes + refresh_token to the handler. We read the
// subdomain from `process.env.ZENDESK_SUBDOMAIN` in dev and fall back
// to erroring if unset. Production callers should arrange for the
// OAuthRefreshHandlerArgs to carry the subdomain via the `scopes`
// array with a `subdomain:<x>` sentinel (a common pattern for
// subdomain-routed vendors).
//
// Prod Secret Manager backing:
//   ZENDESK_CLIENT_ID     → zendesk-oauth-client-id-{env}
//   ZENDESK_CLIENT_SECRET → zendesk-oauth-client-secret-{env}

import {
  OAuthRefreshError,
  registerOAuthRefreshHandler,
  type OAuthRefreshHandler,
} from '../service.js';
import {
  buildSecretData,
  postTokenRequest,
  readStaticClientCreds,
} from './common.js';

const VENDOR = 'zendesk';
const DEFAULT_TTL_SEC = 60 * 60; // 1 hour

function resolveSubdomain(scopes: string[], ctx: { connectorId: string; tenantId: string; vendor: string }): string {
  // Look for a scopes-encoded subdomain sentinel first.
  for (const s of scopes) {
    if (s.startsWith('subdomain:')) {
      const sub = s.slice('subdomain:'.length).trim();
      if (sub) return sub;
    }
  }
  const envSub = process.env.ZENDESK_SUBDOMAIN;
  if (envSub) return envSub;
  throw new OAuthRefreshError(
    'unknown',
    `Zendesk refresh requires a subdomain — scopes must include "subdomain:<name>" or ZENDESK_SUBDOMAIN env var must be set`,
    ctx,
  );
}

const refreshZendesk: OAuthRefreshHandler = async (args) => {
  const ctx = { connectorId: args.connectorId, tenantId: args.tenantId, vendor: VENDOR };
  const { clientId, clientSecret } = readStaticClientCreds({
    clientIdEnvVar: 'ZENDESK_CLIENT_ID',
    clientSecretEnvVar: 'ZENDESK_CLIENT_SECRET',
    ctx,
  });
  const subdomain = resolveSubdomain(args.scopes, ctx);

  // Zendesk prefers JSON body on /oauth/tokens.
  const body = JSON.stringify({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: args.refreshToken,
    scope: args.scopes.filter((s) => !s.startsWith('subdomain:')).join(' ') || 'read write',
  });

  const response = await postTokenRequest({
    url: `https://${subdomain}.zendesk.com/oauth/tokens`,
    headers: { 'Content-Type': 'application/json' },
    body,
    ctx,
  });

  return buildSecretData({
    body: response,
    refreshTokenFallback: args.refreshToken,
    defaultTtlSec: DEFAULT_TTL_SEC,
    scopes: args.scopes.length > 0 ? args.scopes : undefined,
    instanceUrl: `https://${subdomain}.zendesk.com`,
  });
};

registerOAuthRefreshHandler('zendesk', refreshZendesk);

export { refreshZendesk };
