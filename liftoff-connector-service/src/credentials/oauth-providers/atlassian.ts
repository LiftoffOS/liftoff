// Atlassian OAuth refresh handler.
//
// Covers Jira and Confluence — both use the Atlassian auth endpoint at
// https://auth.atlassian.com/oauth/token, and that endpoint accepts a
// JSON body (not form-encoded — this is an Atlassian-specific quirk).
// Atlassian rotates refresh_tokens on every refresh, so we always write
// back whatever refresh_token the vendor returns.
//
// Prod Secret Manager backing:
//   ATLASSIAN_CLIENT_ID     → atlassian-oauth-client-id-{env}
//   ATLASSIAN_CLIENT_SECRET → atlassian-oauth-client-secret-{env}

import {
  registerOAuthRefreshHandler,
  type OAuthRefreshHandler,
} from '../service.js';
import {
  buildSecretData,
  postTokenRequest,
  readStaticClientCreds,
} from './common.js';

const TOKEN_ENDPOINT = 'https://auth.atlassian.com/oauth/token';
const VENDOR = 'atlassian';
const DEFAULT_TTL_SEC = 60 * 60; // 1 hour — Atlassian default

const ATLASSIAN_CONNECTOR_TYPES = ['atlassian_jira', 'atlassian_confluence'];

const refreshAtlassian: OAuthRefreshHandler = async (args) => {
  const ctx = { connectorId: args.connectorId, tenantId: args.tenantId, vendor: VENDOR };
  const { clientId, clientSecret } = readStaticClientCreds({
    clientIdEnvVar: 'ATLASSIAN_CLIENT_ID',
    clientSecretEnvVar: 'ATLASSIAN_CLIENT_SECRET',
    ctx,
  });

  // Atlassian requires JSON body; form-encoding gets a 400.
  const body = JSON.stringify({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: args.refreshToken,
  });

  const response = await postTokenRequest({
    url: TOKEN_ENDPOINT,
    headers: { 'Content-Type': 'application/json' },
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

for (const type of ATLASSIAN_CONNECTOR_TYPES) {
  registerOAuthRefreshHandler(type, refreshAtlassian);
}

export { refreshAtlassian, ATLASSIAN_CONNECTOR_TYPES };
