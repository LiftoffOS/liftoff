// Square OAuth refresh handler.
//
// Square uses a JSON body and requires the `Square-Version` header.
// It returns `expires_at` as an ISO string (not `expires_in` in seconds),
// so we must translate in this handler rather than rely on buildSecretData.
// Square rotates refresh_tokens on refresh.
//
// Prod Secret Manager backing:
//   SQUARE_CLIENT_ID     → square-oauth-client-id-{env}
//   SQUARE_CLIENT_SECRET → square-oauth-client-secret-{env}

import {
  registerOAuthRefreshHandler,
  type OAuthRefreshHandler,
} from '../service.js';
import {
  postTokenRequest,
  readStaticClientCreds,
} from './common.js';
import type { ConnectorSecretData } from '../../secrets/client.js';

const TOKEN_ENDPOINT = 'https://connect.squareup.com/oauth2/token';
const VENDOR = 'square';
const DEFAULT_EXPIRY_DAYS_SEC = 30 * 24 * 60 * 60;

const refreshSquare: OAuthRefreshHandler = async (args) => {
  const ctx = { connectorId: args.connectorId, tenantId: args.tenantId, vendor: VENDOR };
  const { clientId, clientSecret } = readStaticClientCreds({
    clientIdEnvVar: 'SQUARE_CLIENT_ID',
    clientSecretEnvVar: 'SQUARE_CLIENT_SECRET',
    ctx,
  });

  const body = JSON.stringify({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: args.refreshToken,
  });

  const response = await postTokenRequest({
    url: TOKEN_ENDPOINT,
    headers: {
      'Content-Type': 'application/json',
      'Square-Version': '2024-01-17',
    },
    body,
    ctx,
  });

  // Square returns expires_at as an ISO string, not expires_in.
  const rawExpiresAt = (response as { expires_at?: string }).expires_at;
  const expiresAt = rawExpiresAt
    ? new Date(rawExpiresAt).toISOString()
    : new Date(Date.now() + DEFAULT_EXPIRY_DAYS_SEC * 1000).toISOString();

  const out: ConnectorSecretData = {
    accessToken: response.access_token,
    refreshToken: response.refresh_token ?? args.refreshToken,
    expiresAt,
    scopes: args.scopes.length > 0 ? args.scopes : undefined,
  };
  return out;
};

registerOAuthRefreshHandler('square', refreshSquare);

export { refreshSquare };
