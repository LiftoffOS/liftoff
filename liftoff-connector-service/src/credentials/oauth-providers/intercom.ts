// Intercom OAuth refresh handler.
//
// Form-encoded request. Intercom MAY return a new refresh_token; when
// it doesn't, we preserve the existing one. Default TTL is 24h — the
// endpoint sometimes omits expires_in.
//
// Prod Secret Manager backing:
//   INTERCOM_CLIENT_ID     → intercom-oauth-client-id-{env}
//   INTERCOM_CLIENT_SECRET → intercom-oauth-client-secret-{env}

import {
  registerOAuthRefreshHandler,
  type OAuthRefreshHandler,
} from '../service.js';
import {
  buildSecretData,
  postTokenRequest,
  readStaticClientCreds,
} from './common.js';

const TOKEN_ENDPOINT = 'https://api.intercom.io/auth/eagle/token';
const VENDOR = 'intercom';
const DEFAULT_TTL_SEC = 24 * 60 * 60; // 24 hours — Intercom often omits expires_in

const refreshIntercom: OAuthRefreshHandler = async (args) => {
  const ctx = { connectorId: args.connectorId, tenantId: args.tenantId, vendor: VENDOR };
  const { clientId, clientSecret } = readStaticClientCreds({
    clientIdEnvVar: 'INTERCOM_CLIENT_ID',
    clientSecretEnvVar: 'INTERCOM_CLIENT_SECRET',
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
  });

  return buildSecretData({
    body: response,
    refreshTokenFallback: args.refreshToken,
    defaultTtlSec: DEFAULT_TTL_SEC,
    scopes: args.scopes.length > 0 ? args.scopes : undefined,
  });
};

registerOAuthRefreshHandler('intercom', refreshIntercom);

export { refreshIntercom };
