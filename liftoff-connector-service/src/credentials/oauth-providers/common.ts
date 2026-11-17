// Shared helpers for OAuth refresh provider modules.
//
// Each provider module registers one or more connector-type handlers via
// `registerOAuthRefreshHandler`. The handlers POST to the vendor's token
// endpoint with a refresh_token grant and return a `ConnectorSecretData`
// carrying the new access_token (+ rotated refresh_token, scopes, expiry).
//
// Error classification contract:
//   - HTTP 401 or body contains RFC 6749 "invalid_grant" / "invalid_token"
//     / "unauthorized_client" / "access_denied" / "token_revoked"
//     → OAuthRefreshError('reconnect_required'): user must reconnect.
//   - HTTP 5xx, network errors, timeouts
//     → OAuthRefreshError('vendor_unavailable'): transient, safe to retry.
//   - Anything else we can't classify
//     → OAuthRefreshError('unknown').
//
// SSRF: provider modules use hardcoded well-known vendor URLs, except
// DCR providers which read the issuer's tokenEndpoint from the
// `oauth_dynamic_registrations` table and host-allowlist it.

import { OAuthRefreshError, isReconnectOAuthErrorCode } from '../service.js';
import type { ConnectorSecretData } from '../../secrets/client.js';

export interface ProviderErrorContext {
  connectorId: string;
  tenantId: string;
  vendor: string;
}

export interface RefreshResponseBody {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  instance_url?: string;
  token_type?: string;
  scope?: string;
  ok?: boolean;
  error?: string;
  error_description?: string;
  status?: string;
  message?: string;
  [key: string]: unknown;
}

/**
 * Map a fetch error, HTTP status, and response body into a typed
 * OAuthRefreshError. Providers call this from their catch block and
 * on any error body they receive.
 */
export function classifyVendorError(
  args: {
    ctx: ProviderErrorContext;
    httpStatus?: number;
    body?: RefreshResponseBody | null;
    cause?: unknown;
  },
): OAuthRefreshError {
  const { ctx, httpStatus, body, cause } = args;
  const errCode = (body?.error ?? '').toString().toLowerCase();
  const errDesc = (body?.error_description ?? body?.message ?? '').toString();

  // Reconnect cases: 401 or explicit RFC 6749 error codes.
  if (httpStatus === 401 || (errCode && isReconnectOAuthErrorCode(errCode))) {
    return new OAuthRefreshError(
      'reconnect_required',
      `${ctx.vendor} refresh_token is no longer valid — user must reconnect${errDesc ? `: ${errDesc}` : ''}`,
      ctx,
    );
  }

  // 5xx / network → transient.
  if ((httpStatus !== undefined && httpStatus >= 500) || cause) {
    const msg = cause instanceof Error ? cause.message : `HTTP ${httpStatus}`;
    return new OAuthRefreshError(
      'vendor_unavailable',
      `${ctx.vendor} token endpoint unavailable: ${msg}`,
      ctx,
    );
  }

  // 4xx with no recognizable OAuth error code → unknown (not retry-safe).
  return new OAuthRefreshError(
    'unknown',
    `${ctx.vendor} token refresh failed${httpStatus ? ` (HTTP ${httpStatus})` : ''}${errCode ? `: ${errCode}` : ''}${errDesc ? ` — ${errDesc}` : ''}`,
    ctx,
  );
}

/**
 * POST to a vendor token endpoint and return the parsed JSON body.
 * Throws an OAuthRefreshError on network/HTTP error or vendor error body.
 *
 * Success is determined by the caller via `isSuccess(body)`; the default
 * requires a non-empty `access_token`. (Slack returns `ok: false` on
 * failure even with HTTP 200 — override isSuccess accordingly.)
 */
export async function postTokenRequest(args: {
  url: string;
  headers: Record<string, string>;
  body: string | URLSearchParams;
  ctx: ProviderErrorContext;
  isSuccess?: (body: RefreshResponseBody) => boolean;
}): Promise<RefreshResponseBody> {
  const { url, headers, body, ctx } = args;
  const isSuccess = args.isSuccess ?? ((b) => !!b.access_token && !b.error);

  let response: Response;
  try {
    response = await fetch(url, { method: 'POST', headers, body });
  } catch (cause) {
    throw classifyVendorError({ ctx, cause });
  }

  let parsed: RefreshResponseBody | null = null;
  const text = await response.text();
  if (text) {
    try {
      parsed = JSON.parse(text) as RefreshResponseBody;
    } catch {
      // Non-JSON body; leave parsed as null so classifyVendorError can
      // still report the HTTP status.
      parsed = null;
    }
  }

  if (!response.ok) {
    throw classifyVendorError({ ctx, httpStatus: response.status, body: parsed });
  }

  if (!parsed || !isSuccess(parsed)) {
    // HTTP 200 but body indicates failure (e.g., Slack { ok: false }).
    throw classifyVendorError({ ctx, httpStatus: response.status, body: parsed });
  }

  return parsed;
}

/**
 * Convert an `expires_in` seconds value to an ISO string stored in
 * ConnectorSecretData.expiresAt. Falls back to `defaultSec` if the
 * vendor omits the field.
 */
export function expiresAtIso(expiresInSec: number | undefined, defaultSec: number): string {
  const sec = typeof expiresInSec === 'number' && expiresInSec > 0 ? expiresInSec : defaultSec;
  return new Date(Date.now() + sec * 1000).toISOString();
}

/**
 * Build a ConnectorSecretData response from a token-endpoint body.
 * `args.refreshTokenFallback` is used when the vendor does not rotate
 * refresh_tokens — we must preserve the caller's refresh_token.
 */
export function buildSecretData(args: {
  body: RefreshResponseBody;
  refreshTokenFallback: string;
  defaultTtlSec: number;
  scopes?: string[];
  instanceUrl?: string;
}): ConnectorSecretData {
  const { body, refreshTokenFallback, defaultTtlSec, scopes, instanceUrl } = args;
  const refreshToken = body.refresh_token ?? refreshTokenFallback;
  return {
    accessToken: body.access_token,
    refreshToken,
    tokenType: body.token_type,
    instanceUrl: instanceUrl ?? body.instance_url,
    expiresAt: expiresAtIso(body.expires_in, defaultTtlSec),
    scopes: scopes ?? (body.scope ? body.scope.split(/[\s,]+/).filter(Boolean) : undefined),
  };
}

/**
 * Read client_id + client_secret from env vars. If missing, throw an
 * `unknown` OAuthRefreshError — these are deployment-config bugs, not
 * user-reconnect issues. `secretEnvVar` may be undefined for public
 * clients (DCR).
 */
export function readStaticClientCreds(args: {
  clientIdEnvVar: string;
  clientSecretEnvVar: string;
  ctx: ProviderErrorContext;
}): { clientId: string; clientSecret: string } {
  const clientId = process.env[args.clientIdEnvVar];
  const clientSecret = process.env[args.clientSecretEnvVar];
  if (!clientId || !clientSecret) {
    throw new OAuthRefreshError(
      'unknown',
      `${args.ctx.vendor} OAuth refresh requires ${args.clientIdEnvVar} and ${args.clientSecretEnvVar}; one or both are missing`,
      args.ctx,
    );
  }
  return { clientId, clientSecret };
}
