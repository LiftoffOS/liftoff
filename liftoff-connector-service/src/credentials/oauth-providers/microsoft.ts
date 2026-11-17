// Microsoft (Entra / Azure AD) OAuth refresh handler.
//
// Covers every Microsoft-Graph connector type wired as static_oauth against the
// one multi-tenant Entra app in catalog/connectors.ts — Teams, OneDrive,
// Outlook mail & calendar, OneNote, Planner, SharePoint, To Do, Contacts,
// Excel, Dynamics. All share the v2.0 `/common/` token endpoint and the same
// static MICROSOFT_CLIENT_ID / MICROSOFT_CLIENT_SECRET.
//
// Prod Secret Manager backing (same convention as the other providers):
//   MICROSOFT_CLIENT_ID     → microsoft-oauth-client-id-{env}
//   MICROSOFT_CLIENT_SECRET → microsoft-oauth-client-secret-{env}
//
// Microsoft ROTATES refresh_tokens: because offline_access is granted at
// connect, every refresh returns a NEW refresh_token and invalidates the old
// one. buildSecretData persists response.refresh_token, so the rotation is
// preserved; failing to persist it would break the NEXT refresh.
//
// WHY THIS EXISTS. Without a handler registered for a microsoft_* type, the
// refresh path throws "No OAuth refresh handler registered for microsoft_teams"
// (credentials/service.ts) and flips the connection to `error` the moment its
// ~1h access token expires, so a completed connection would break within the
// hour and reconnecting would only reset the clock.

import {
  registerOAuthRefreshHandler,
  type OAuthRefreshHandler,
} from '../service.js';
import {
  buildSecretData,
  postTokenRequest,
  readStaticClientCreds,
} from './common.js';

// Multi-tenant v2.0 endpoint — the same authority the connect flow authorizes
// against. `/common/` lets both work/school and personal accounts refresh
// through the one app, matching how they connected.
const TOKEN_ENDPOINT = 'https://login.microsoftonline.com/common/oauth2/v2.0/token';
const VENDOR = 'microsoft';
const DEFAULT_TTL_SEC = 3600; // Entra access tokens default to ~1 hour.

// Every microsoft_* type registered as static_oauth with MICROSOFT_CLIENT_ID in
// catalog/connectors.ts. Kept in lockstep by microsoft.test.ts, which fails if
// the catalog adds (or drops) a Microsoft static_oauth connector this list does
// not match — otherwise a new Microsoft connector would silently ship with no
// refresh handler, exactly the bug this file fixes.
// Exactly the microsoft_* connectors the catalog wires as static_oauth against
// MICROSOFT_CLIENT_ID — the ones connector-service refreshes itself. OneDrive,
// Outlook mail, Excel and Dynamics are deliberately NOT here: they are Composio-
// managed (Composio holds and refreshes their tokens), so a connector-service
// refresh handler would never run for them. microsoft.test.ts derives the set
// from the catalog and fails if this drifts.
const MICROSOFT_CONNECTOR_TYPES = [
  'microsoft_teams',
  'microsoft_outlook_calendar',
  'microsoft_onenote',
  'microsoft_planner',
  'microsoft_sharepoint',
  'microsoft_todo',
  'microsoft_contacts',
];

const refreshMicrosoft: OAuthRefreshHandler = async (args) => {
  const ctx = { connectorId: args.connectorId, tenantId: args.tenantId, vendor: VENDOR };
  const { clientId, clientSecret } = readStaticClientCreds({
    clientIdEnvVar: 'MICROSOFT_CLIENT_ID',
    clientSecretEnvVar: 'MICROSOFT_CLIENT_SECRET',
    ctx,
  });

  // No `scope` on the refresh_token grant: the v2.0 endpoint reuses the scopes
  // consented at connect and still returns a rotated refresh_token because
  // offline_access was among them. Sending scope risks a narrower grant.
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

  // An expired/revoked refresh_token comes back as HTTP 400 + { error:
  // 'invalid_grant' }, which postTokenRequest → classifyVendorError maps to
  // reconnect_required (invalid_grant is a recognized RFC 6749 reconnect code),
  // so a genuinely dead grant still surfaces as "reconnect", not a silent retry.
  return buildSecretData({
    body: response,
    refreshTokenFallback: args.refreshToken,
    defaultTtlSec: DEFAULT_TTL_SEC,
    scopes: args.scopes.length > 0 ? args.scopes : undefined,
  });
};

for (const type of MICROSOFT_CONNECTOR_TYPES) {
  registerOAuthRefreshHandler(type, refreshMicrosoft);
}

export { refreshMicrosoft, MICROSOFT_CONNECTOR_TYPES };
