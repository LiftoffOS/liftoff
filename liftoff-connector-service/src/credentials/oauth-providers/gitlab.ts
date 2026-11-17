// GitLab OAuth refresh handler (standard RFC 6749 refresh_token grant, with rotation).
//
// gitlab.com access tokens expire after 2 hours, and the initial
// authorization_code exchange returns a refresh_token alongside them.
// Without a registered handler, connector-service could not refresh, so a
// gitlab connector flipped to `error: reconnect required` roughly every two
// hours — both the poll cycle and every GetCredentials call route through
// refreshOAuth, and an unregistered type there throws OAuthRefreshError.
//
// GitLab ROTATES refresh_tokens: each refresh returns a NEW refresh_token and
// invalidates the previous one, so we must always persist the new value.
// buildSecretData() prefers body.refresh_token over the fallback, so rotation
// is handled without special-casing here.
//
// A dead/already-rotated refresh_token comes back as HTTP 400 invalid_grant,
// which classifyVendorError maps to reconnect_required (user must reconnect).
//
// Prod Secret Manager backing:
//   GITLAB_CLIENT_ID     → gitlab-oauth-client-id-{env}
//   GITLAB_CLIENT_SECRET → gitlab-oauth-client-secret-{env}

import {
  registerOAuthRefreshHandler,
  type OAuthRefreshHandler,
} from '../service.js';
import {
  buildSecretData,
  postTokenRequest,
  readStaticClientCreds,
} from './common.js';

const TOKEN_ENDPOINT = 'https://gitlab.com/oauth/token';
const VENDOR = 'gitlab';
const DEFAULT_TTL_SEC = 2 * 60 * 60; // 7200s — gitlab.com access-token default

const refreshGitlab: OAuthRefreshHandler = async (args) => {
  const ctx = { connectorId: args.connectorId, tenantId: args.tenantId, vendor: VENDOR };
  const { clientId, clientSecret } = readStaticClientCreds({
    clientIdEnvVar: 'GITLAB_CLIENT_ID',
    clientSecretEnvVar: 'GITLAB_CLIENT_SECRET',
    ctx,
  });

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: args.refreshToken,
  });

  // Standard OAuth2 token endpoint: meaningful HTTP status codes, JSON body.
  // The default isSuccess (access_token present, no error) applies.
  const response = await postTokenRequest({
    url: TOKEN_ENDPOINT,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    ctx,
  });

  return buildSecretData({
    body: response,
    refreshTokenFallback: args.refreshToken,
    defaultTtlSec: DEFAULT_TTL_SEC,
    scopes: args.scopes.length > 0 ? args.scopes : undefined,
  });
};

registerOAuthRefreshHandler('gitlab', refreshGitlab);

export { refreshGitlab };
