// GitHub OAuth refresh handler.
//
// GitHub's token endpoint (https://github.com/login/oauth/access_token)
// returns form-encoded bodies by default, so we force JSON via the
// Accept header. It rotates refresh_tokens and access_tokens on every
// refresh. GitHub uses "bad_refresh_token" in addition to standard
// RFC error codes — classifyVendorError treats unknown error codes as
// 'unknown', so we need to handle that case specifically.
//
// Prod Secret Manager backing:
//   GITHUB_CLIENT_ID     → github-oauth-client-id-{env}
//   GITHUB_CLIENT_SECRET → github-oauth-client-secret-{env}

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

const TOKEN_ENDPOINT = 'https://github.com/login/oauth/access_token';
const VENDOR = 'github';
const DEFAULT_TTL_SEC = 8 * 60 * 60; // 8 hours — GitHub default

const refreshGitHub: OAuthRefreshHandler = async (args) => {
  const ctx = { connectorId: args.connectorId, tenantId: args.tenantId, vendor: VENDOR };
  const { clientId, clientSecret } = readStaticClientCreds({
    clientIdEnvVar: 'GITHUB_CLIENT_ID',
    clientSecretEnvVar: 'GITHUB_CLIENT_SECRET',
    ctx,
  });

  const body = new URLSearchParams({
    grant_type: 'refresh_token',
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: args.refreshToken,
  });

  try {
    const response = await postTokenRequest({
      url: TOKEN_ENDPOINT,
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body,
      ctx,
    });

    return buildSecretData({
      body: response,
      refreshTokenFallback: args.refreshToken,
      defaultTtlSec: DEFAULT_TTL_SEC,
      scopes: args.scopes.length > 0 ? args.scopes : undefined,
    });
  } catch (err) {
    if (err instanceof OAuthRefreshError && err.reason === 'unknown') {
      // GitHub-specific: "bad_refresh_token" means reconnect, not retry.
      const msg = err.message.toLowerCase();
      if (msg.includes('bad_refresh_token') || msg.includes('bad_verification_code')) {
        throw new OAuthRefreshError(
          'reconnect_required',
          `GitHub refresh_token is invalid: ${err.message}`,
          ctx,
        );
      }
    }
    throw err;
  }
};

registerOAuthRefreshHandler('github', refreshGitHub);

export { refreshGitHub };
