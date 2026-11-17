// Google OAuth refresh handler.
//
// Covers every connector type in the Google family — Drive, Docs, Sheets,
// Slides, Mail (Gmail), Calendar, Contacts, Tasks, BigQuery, Firestore.
// All use the same oauth2.googleapis.com/token endpoint and the same
// static client_id / client_secret (one GCP OAuth client per deployment).
//
// Prod Secret Manager backing:
//   GOOGLE_CLIENT_ID     → google-oauth-client-id-{env}
//   GOOGLE_CLIENT_SECRET → google-oauth-client-secret-{env}
//
// Google does NOT rotate refresh_tokens, so we always persist the original.

import {
  registerOAuthRefreshHandler,
  registerOAuthRevocationHandler,
  type OAuthRefreshHandler,
} from '../service.js';
import {
  buildSecretData,
  classifyVendorError,
  postTokenRequest,
  readStaticClientCreds,
} from './common.js';
import { logger } from '../../infra/logging.js';

const TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const VENDOR = 'google';
const DEFAULT_TTL_SEC = 3600; // 1 hour

const GOOGLE_CONNECTOR_TYPES = [
  'google',
  'google_calendar',
  'google_drive',
  'google_mail',
  'google_sheets',
  'google_docs',
  'google_slides',
  'google_contacts',
  'google_tasks',
  'google_bigquery',
  'google_firestore',
];

const refreshGoogle: OAuthRefreshHandler = async (args) => {
  const ctx = { connectorId: args.connectorId, tenantId: args.tenantId, vendor: VENDOR };
  const { clientId, clientSecret } = readStaticClientCreds({
    clientIdEnvVar: 'GOOGLE_CLIENT_ID',
    clientSecretEnvVar: 'GOOGLE_CLIENT_SECRET',
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

  // Defensive: Google should always return expires_in on success. If it
  // doesn't, we'd silently write a secret with no expiry and the token
  // would never be refreshed — fail loudly instead.
  if (typeof response.expires_in !== 'number') {
    throw classifyVendorError({
      ctx,
      httpStatus: 200,
      body: {
        error: 'malformed_response',
        error_description: `missing expires_in: ${JSON.stringify(response)}`,
      },
    });
  }

  return buildSecretData({
    body: response,
    refreshTokenFallback: args.refreshToken,
    defaultTtlSec: DEFAULT_TTL_SEC,
    scopes: args.scopes.length > 0 ? args.scopes : undefined,
  });
};

const REVOKE_ENDPOINT = 'https://oauth2.googleapis.com/revoke';

for (const type of GOOGLE_CONNECTOR_TYPES) {
  registerOAuthRefreshHandler(type, refreshGoogle);
  registerOAuthRevocationHandler(type, async (args) => {
    // Best-effort: if Google rejects the token (already expired/revoked),
    // we still complete the local disconnect. The important effect is that
    // a future reconnect will be treated as first-time auth and Google will
    // return a fresh refresh_token.
    try {
      const body = new URLSearchParams({ token: args.accessToken });
      const response = await fetch(REVOKE_ENDPOINT, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: body.toString(),
      });
      if (!response.ok) {
        const text = await response.text().catch(() => '');
        logger.warn(
          { connectorId: args.connectorId, status: response.status, body: text.slice(0, 200) },
          'Google token revocation non-OK (token may already be expired)',
        );
      }
    } catch (err) {
      logger.warn(
        { connectorId: args.connectorId, error: (err as Error).message },
        'Google token revocation request failed (non-fatal)',
      );
    }
  });
}

export { refreshGoogle, GOOGLE_CONNECTOR_TYPES };
