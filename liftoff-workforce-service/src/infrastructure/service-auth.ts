// Service-to-service OIDC token fetching for liftoff-workforce-service.
//
// getIdTokenForAudience() mints a Google OIDC identity token for outbound
// service calls. Tokens are valid for 60 minutes; we cache them for 50 minutes
// to leave a safety margin for clock skew and slow token delivery.
//
// In non-GCP environments (no metadata server) the error is caught and an
// empty bearer header is returned so local dev doesn't crash.

import { GoogleAuth } from 'google-auth-library';
import { log } from './logging.js';

// Cache entry: token string + unix-ms expiry
interface CacheEntry {
  token: string;
  expiresAt: number;
}

const TOKEN_CACHE = new Map<string, CacheEntry>();

// 50 minutes in milliseconds — tokens are valid 60 min, 10 min headroom
const CACHE_TTL_MS = 50 * 60 * 1000;

const auth = new GoogleAuth();

/**
 * Mint (or return a cached) Google OIDC identity token for `audience`.
 * Falls back to an empty string in environments without a GCP metadata server.
 */
export async function getIdTokenForAudience(audience: string): Promise<string> {
  const now = Date.now();
  const cached = TOKEN_CACHE.get(audience);
  if (cached && cached.expiresAt > now) {
    return cached.token;
  }

  try {
    const client = await auth.getIdTokenClient(audience);
    const tokenResponse = await client.getRequestHeaders();
    // getRequestHeaders returns { Authorization: 'Bearer <token>' }
    const authHeader = tokenResponse['Authorization'] ?? tokenResponse['authorization'] ?? '';
    const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

    TOKEN_CACHE.set(audience, { token, expiresAt: now + CACHE_TTL_MS });
    return token;
  } catch (err) {
    log.warn(
      { audience, err: (err as Error).message },
      'Failed to fetch OIDC identity token — no GCP metadata server? Falling back to empty bearer.',
    );
    return '';
  }
}

/**
 * Build the outbound HTTP headers object for a service-to-service call.
 *
 * Always includes `Authorization: Bearer <oidc-token>` (token may be empty
 * in local dev). Includes `X-Service-Auth` only when `serviceAuthSecret` is
 * truthy.
 */
export async function getServiceAuthHeaders(
  audience: string,
  serviceAuthSecret?: string,
): Promise<Record<string, string>> {
  const token = await getIdTokenForAudience(audience);
  const headers: Record<string, string> = {
    Authorization: `Bearer ${token}`,
  };
  if (serviceAuthSecret) {
    headers['X-Service-Auth'] = serviceAuthSecret;
  }
  return headers;
}
