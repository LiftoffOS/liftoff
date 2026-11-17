// Client ID Metadata Documents (CIMD) — MCP 2026-07-28 client registration.
//
// DCR is deprecated in favor of CIMD: a client identifies itself with an HTTPS
// URL as its client_id, and the URL serves a JSON metadata document
// (client_id, client_name, redirect_uris, ...). The authorization server
// resolves URL-form client_ids on demand and validates the document before
// treating the client as registered. See:
//   https://modelcontextprotocol.io/specification/2026-07-28/basic/authorization/client-registration
//
// SECURITY: the client_id URL is attacker-controlled, so the fetch is
// SSRF-guarded — https only, DNS resolved and checked against private /
// loopback / link-local ranges, no redirects followed, byte-size + timeout
// capped. On ANY validation failure we return null and the caller fails closed
// (invalid_client), never partially trusting a document.

import { log } from '../infrastructure/logging';
import { negotiateGrantTypes, usesDeviceGrant } from './client-grants';
import { assertPublicHost } from '../common/url-guard';

const FETCH_TIMEOUT_MS = 5000;
const MAX_DOC_BYTES = 128 * 1024; // 128 KB — CIMD docs are tiny
const CIMD_MIN_TTL_MS = 5 * 60 * 1000;        // 5 min floor
const CIMD_MAX_TTL_MS = 24 * 60 * 60 * 1000;  // 24 h cap

/** Registered redirect-URI entry, matching the oauth_clients JSONB shape. */
export interface CimdRedirect {
  uri: string;
  loopback_port_wildcard: boolean;
}

export interface CimdClient {
  client_name: string;
  redirect_uris: CimdRedirect[];
  /** The grants the document asks for, narrowed to what we serve; the pair
   *  every client got before the device grant when it names none. */
  grant_types: string[];
  /** When to re-fetch + re-validate the metadata document, derived from its
   *  HTTP cache headers and clamped to [5min, 24h]. Persisted as
   *  oauth_clients.cimd_cached_until so the authorize handler refreshes a
   *  client that rotates its redirect_uris without operator intervention. */
  cachedUntil: Date;
}

/** Freshness horizon from Cache-Control max-age (else Expires), clamped to
 *  [CIMD_MIN_TTL_MS, CIMD_MAX_TTL_MS]. no-store/no-cache and a missing header
 *  fall back to the minimum — we still need a row for the FK, so we cache
 *  briefly rather than not at all, and re-validate soon. */
function cacheHorizon(headers?: { get?: (k: string) => string | null }): Date {
  const now = Date.now();
  let ttlMs = CIMD_MIN_TTL_MS;
  const cc = headers?.get?.('cache-control') ?? '';
  if (/\bno-store\b|\bno-cache\b/i.test(cc)) {
    ttlMs = CIMD_MIN_TTL_MS;
  } else {
    const maxAge = /\bmax-age\s*=\s*(\d+)/i.exec(cc);
    if (maxAge) {
      ttlMs = parseInt(maxAge[1], 10) * 1000;
    } else {
      const expires = headers?.get?.('expires');
      const parsed = expires ? Date.parse(expires) : NaN;
      if (!Number.isNaN(parsed)) ttlMs = parsed - now;
    }
  }
  const clamped = Math.min(Math.max(ttlMs, CIMD_MIN_TTL_MS), CIMD_MAX_TTL_MS);
  return new Date(now + clamped);
}

/** A CIMD client_id is an https URL WITH a path component (per spec). Our
 *  first-party DCR clients use the opaque `liftoff_oc_*` form, so this cleanly
 *  distinguishes the two without a flag. */
// The private-address checks live in src/common/url-guard.ts now: this file
// was the only place in the repo that had them, while every other
// tenant-supplied URL went unguarded. Same logic, one home, applied
// everywhere.

export function isCimdClientId(clientId: string): boolean {
  let u: URL;
  try {
    u = new URL(clientId);
  } catch {
    return false;
  }
  return u.protocol === 'https:' && u.pathname.length > 1;
}

/**
 * Resolve a URL-form client_id into a validated CimdClient, or null if the
 * client_id is not CIMD-shaped or the document fails any check. `validateUri`
 * is the caller's registrable-redirect-URI validator (reused so CIMD and DCR
 * apply identical redirect rules).
 */
export async function resolveCimdClient(
  clientId: string,
  validateUri: (raw: string) => CimdRedirect | null,
): Promise<CimdClient | null> {
  if (!isCimdClientId(clientId)) return null;

  const url = new URL(clientId);
  try {
    await assertPublicHost(url.hostname);
  } catch (err) {
    log.warn({ event: 'cimd_ssrf_block', clientId, error: (err as Error).message }, 'CIMD host blocked');
    return null;
  }

  let resp: Response;
  try {
    resp = await fetch(clientId, {
      method: 'GET',
      redirect: 'error', // do not follow redirects (RFC: no non-https hops)
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (err) {
    log.warn({ event: 'cimd_fetch_failed', clientId, error: (err as Error).message }, 'CIMD fetch failed');
    return null;
  }
  if (!resp.ok) {
    log.warn({ event: 'cimd_fetch_status', clientId, status: resp.status }, 'CIMD fetch non-2xx');
    return null;
  }

  const text = await resp.text();
  if (text.length > MAX_DOC_BYTES) {
    log.warn({ event: 'cimd_doc_too_large', clientId, bytes: text.length }, 'CIMD document exceeds size cap');
    return null;
  }

  let doc: Record<string, unknown>;
  try {
    doc = JSON.parse(text) as Record<string, unknown>;
  } catch {
    log.warn({ event: 'cimd_doc_not_json', clientId }, 'CIMD document is not valid JSON');
    return null;
  }

  // MUST: the document's client_id equals the URL exactly.
  if (doc.client_id !== clientId) {
    log.warn({ event: 'cimd_client_id_mismatch', clientId }, 'CIMD client_id does not match the document URL');
    return null;
  }
  // MUST include client_name, and at least one redirect_uri unless the
  // document registers for the device grant, which needs none.
  if (typeof doc.client_name !== 'string' || doc.client_name.length === 0) return null;
  const requestedGrants = Array.isArray(doc.grant_types)
    ? doc.grant_types.filter((g): g is string => typeof g === 'string')
    : undefined;
  const grant_types = negotiateGrantTypes(requestedGrants);
  if (!grant_types) {
    log.warn({ event: 'cimd_no_supported_grant', clientId }, 'CIMD document names no grant we serve');
    return null;
  }
  const rawRedirects = Array.isArray(doc.redirect_uris) ? doc.redirect_uris : [];
  if (rawRedirects.length === 0 && !usesDeviceGrant(grant_types)) return null;

  const redirect_uris: CimdRedirect[] = [];
  for (const raw of rawRedirects) {
    if (typeof raw !== 'string') return null;
    const validated = validateUri(raw);
    if (!validated) {
      log.warn({ event: 'cimd_bad_redirect', clientId }, 'CIMD document has an invalid redirect_uri');
      return null;
    }
    redirect_uris.push(validated);
  }

  return { client_name: doc.client_name, redirect_uris, grant_types, cachedUntil: cacheHorizon(resp.headers) };
}
