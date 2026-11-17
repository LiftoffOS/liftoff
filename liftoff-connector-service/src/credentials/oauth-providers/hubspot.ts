// HubSpot OAuth refresh handler.
//
// Form-encoded request body. HubSpot rotates refresh_tokens, and also
// returns a `status:"error"` wrapper on failure in addition to the
// standard OAuth `error` field. `postTokenRequest` handles the HTTP
// status mapping; we override isSuccess to account for `status:"error"`.
//
// Prod Secret Manager backing:
//   HUBSPOT_CLIENT_ID     → hubspot-oauth-client-id-{env}
//   HUBSPOT_CLIENT_SECRET → hubspot-oauth-client-secret-{env}

import {
  registerOAuthRefreshHandler,
  type OAuthRefreshHandler,
} from '../service.js';
import {
  buildSecretData,
  postTokenRequest,
  readStaticClientCreds,
} from './common.js';

const TOKEN_ENDPOINT = 'https://api.hubapi.com/oauth/v1/token';
const VENDOR = 'hubspot';
const DEFAULT_TTL_SEC = 30 * 60; // 30 minutes — HubSpot default

const refreshHubSpot: OAuthRefreshHandler = async (args) => {
  const ctx = { connectorId: args.connectorId, tenantId: args.tenantId, vendor: VENDOR };
  const { clientId, clientSecret } = readStaticClientCreds({
    clientIdEnvVar: 'HUBSPOT_CLIENT_ID',
    clientSecretEnvVar: 'HUBSPOT_CLIENT_SECRET',
    ctx,
  });

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: args.refreshToken,
  });

  const response = await postTokenRequest({
    url: TOKEN_ENDPOINT,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    ctx,
    isSuccess: (b) => !!b.access_token && b.status !== 'error' && !b.error,
  });

  return buildSecretData({
    body: response,
    refreshTokenFallback: args.refreshToken,
    defaultTtlSec: DEFAULT_TTL_SEC,
    scopes: args.scopes.length > 0 ? args.scopes : undefined,
  });
};

registerOAuthRefreshHandler('hubspot', refreshHubSpot);

export { refreshHubSpot };
