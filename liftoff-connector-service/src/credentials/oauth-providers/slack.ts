// Slack OAuth refresh handler (token-rotation flow).
//
// Slack's oauth.v2.access endpoint returns HTTP 200 on BOTH success and
// failure; the `ok:true|false` field in the body is the real status.
// `ok:false` + `error:"invalid_auth"` or similar signals a dead refresh
// token. We map those to reconnect_required via the shared helper.
//
// Prod Secret Manager backing:
//   SLACK_CLIENT_ID     → slack-oauth-client-id-{env}
//   SLACK_CLIENT_SECRET → slack-oauth-client-secret-{env}
//
// Slack rotates refresh_tokens on every refresh when token rotation is
// enabled on the app. We always persist data.refresh_token when present.

import {
  registerOAuthRefreshHandler,
  type OAuthRefreshHandler,
} from '../service.js';
import {
  buildSecretData,
  postTokenRequest,
  readStaticClientCreds,
} from './common.js';

const TOKEN_ENDPOINT = 'https://slack.com/api/oauth.v2.access';
const VENDOR = 'slack';
const DEFAULT_TTL_SEC = 12 * 60 * 60; // 12 hours — Slack default

const refreshSlack: OAuthRefreshHandler = async (args) => {
  const ctx = { connectorId: args.connectorId, tenantId: args.tenantId, vendor: VENDOR };
  const { clientId, clientSecret } = readStaticClientCreds({
    clientIdEnvVar: 'SLACK_CLIENT_ID',
    clientSecretEnvVar: 'SLACK_CLIENT_SECRET',
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
    // Slack success check: ok:true AND access_token present.
    isSuccess: (b) => b.ok === true && !!b.access_token,
  });

  return buildSecretData({
    body: response,
    refreshTokenFallback: args.refreshToken,
    defaultTtlSec: DEFAULT_TTL_SEC,
    scopes: args.scopes.length > 0 ? args.scopes : undefined,
  });
};

registerOAuthRefreshHandler('slack', refreshSlack);

export { refreshSlack };
