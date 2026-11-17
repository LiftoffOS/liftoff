// Salesforce OAuth refresh handler.
//
// Salesforce returns an instance_url on every refresh — we MUST persist
// it because API calls route through per-org instances. It does NOT
// rotate refresh_tokens. The token endpoint defaults to login.salesforce.com
// but the caller may pin it to a sandbox via `args.scopes[0]` (kept in
// `ConnectorCredentialRecord.extra.instanceUrl`); for simplicity we use
// the login URL — instance_url returned in the response tells us where
// API calls should go.
//
// Prod Secret Manager backing:
//   SALESFORCE_CLIENT_ID     → salesforce-oauth-client-id-{env}
//   SALESFORCE_CLIENT_SECRET → salesforce-oauth-client-secret-{env}

import {
  registerOAuthRefreshHandler,
  type OAuthRefreshHandler,
} from '../service.js';
import {
  buildSecretData,
  postTokenRequest,
  readStaticClientCreds,
} from './common.js';

const DEFAULT_TOKEN_ENDPOINT = 'https://login.salesforce.com/services/oauth2/token';
const VENDOR = 'salesforce';
const DEFAULT_TTL_SEC = 2 * 60 * 60; // 2 hours

const refreshSalesforce: OAuthRefreshHandler = async (args) => {
  const ctx = { connectorId: args.connectorId, tenantId: args.tenantId, vendor: VENDOR };
  const { clientId, clientSecret } = readStaticClientCreds({
    clientIdEnvVar: 'SALESFORCE_CLIENT_ID',
    clientSecretEnvVar: 'SALESFORCE_CLIENT_SECRET',
    ctx,
  });

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: args.refreshToken,
  });

  const response = await postTokenRequest({
    url: DEFAULT_TOKEN_ENDPOINT,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body,
    ctx,
  });

  return buildSecretData({
    body: response,
    refreshTokenFallback: args.refreshToken, // Salesforce doesn't rotate.
    defaultTtlSec: DEFAULT_TTL_SEC,
    scopes: args.scopes.length > 0 ? args.scopes : undefined,
    instanceUrl: (response.instance_url as string | undefined) ?? undefined,
  });
};

registerOAuthRefreshHandler('salesforce', refreshSalesforce);

export { refreshSalesforce };
