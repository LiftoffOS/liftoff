// Preflight token — stateless HMAC-SHA256 signed token returned from
// Preflight and echoed back on every Authorize / Record call tied to an
// invocation.
//
// Format:  <base64url(json-payload)>.<base64url(hmac-sha256)>
//
// Rationale for HMAC over JWT: the token never leaves our service mesh
// (tenant-runtime ↔ governance-engine only), the payload is tiny, and we
// want rotation without a library dep. ~30 LoC vs pulling in jsonwebtoken.
//
// Signing key resolution order:
//   1. process.env.GOVERNANCE_PREFLIGHT_SIGNING_KEY
//   2. process.env.GOVERNANCE_SERVICE_TOKEN (shared service-auth token —
//      already in Secret Manager, good enough for dev; rotate via the
//      dedicated key in prod)
//   3. process.env.GOVERNANCE_ENGINE_TOKEN (legacy name — kept so a
//      rolling rename across services doesn't break preflight sign/verify
//      while the new name rolls out; remove after all callers migrate)
// If none is set we throw at sign time — fail-closed.
//
// TTL: 30 seconds per plan, matching the tenant-runtime preflight cache.
// An expired token is rejected by verify(); callers should refetch
// preflight.

import crypto from 'node:crypto';

export const PREFLIGHT_TOKEN_TTL_MS = 30_000;

export interface PreflightClaims {
  tenantId: string;
  agentId: string;
  invocationId?: string;
  capabilityTier: string;
  executionEnvironment: string;
  hitlLevel: number;
  // Admission snapshot at preflight time. Authorize uses this to short-
  // circuit re-querying admission on the hot path — if the caller's
  // snapshot says BLOCKED, the call is BLOCKED.
  admissionStatus: 'ADMITTED' | 'THROTTLED' | 'BLOCKED' | 'UNSPECIFIED';
  // Monotonic version tag — mirrors the `version` string on
  // PreflightResponse so clients know when to refresh their cache.
  preflightVersion: string;
  issuedAt: number; // epoch ms
  expiresAt: number; // epoch ms
}

export interface VerifiedPreflightToken {
  valid: true;
  claims: PreflightClaims;
}

export interface InvalidPreflightToken {
  valid: false;
  reason:
    | 'malformed'
    | 'bad-signature'
    | 'expired'
    | 'missing-signing-key'
    | 'invalid-payload';
}

export type PreflightTokenVerifyResult =
  | VerifiedPreflightToken
  | InvalidPreflightToken;

function getSigningKey(): string | null {
  return (
    process.env.GOVERNANCE_PREFLIGHT_SIGNING_KEY ||
    process.env.GOVERNANCE_SERVICE_TOKEN ||
    process.env.GOVERNANCE_ENGINE_TOKEN || // legacy fallback
    null
  );
}

function base64urlEncode(buf: Buffer): string {
  return buf
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function base64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? 0 : 4 - (s.length % 4);
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat(pad);
  return Buffer.from(b64, 'base64');
}

function hmac(key: string, payload: string): Buffer {
  return crypto.createHmac('sha256', key).update(payload).digest();
}

/**
 * Sign a set of preflight claims into a compact HMAC-SHA256 token.
 *
 * `issuedAt` and `expiresAt` are auto-populated if not supplied. Supply
 * them explicitly only from tests that need deterministic timing.
 */
export function signPreflightToken(
  claims: Omit<PreflightClaims, 'issuedAt' | 'expiresAt'> &
    Partial<Pick<PreflightClaims, 'issuedAt' | 'expiresAt'>>,
): string {
  const key = getSigningKey();
  if (!key) {
    throw new Error(
      'signPreflightToken: none of GOVERNANCE_PREFLIGHT_SIGNING_KEY, GOVERNANCE_SERVICE_TOKEN, or GOVERNANCE_ENGINE_TOKEN (legacy) is set',
    );
  }

  const now = Date.now();
  const full: PreflightClaims = {
    ...claims,
    issuedAt: claims.issuedAt ?? now,
    expiresAt: claims.expiresAt ?? now + PREFLIGHT_TOKEN_TTL_MS,
  };

  const payloadJson = JSON.stringify(full);
  const payloadB64 = base64urlEncode(Buffer.from(payloadJson, 'utf8'));
  const sig = hmac(key, payloadB64);
  const sigB64 = base64urlEncode(sig);
  return `${payloadB64}.${sigB64}`;
}

/**
 * Verify a preflight token signature + expiry. Returns a discriminated
 * union so callers can branch on the specific failure mode.
 *
 * IMPORTANT: uses timingSafeEqual for the signature comparison.
 */
export function verifyPreflightToken(
  token: string,
  nowMs: number = Date.now(),
): PreflightTokenVerifyResult {
  if (typeof token !== 'string' || token.length === 0) {
    return { valid: false, reason: 'malformed' };
  }

  const key = getSigningKey();
  if (!key) {
    return { valid: false, reason: 'missing-signing-key' };
  }

  const dot = token.indexOf('.');
  if (dot <= 0 || dot === token.length - 1) {
    return { valid: false, reason: 'malformed' };
  }
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);

  const expectedSig = hmac(key, payloadB64);
  let providedSig: Buffer;
  try {
    providedSig = base64urlDecode(sigB64);
  } catch {
    return { valid: false, reason: 'malformed' };
  }

  if (
    providedSig.length !== expectedSig.length ||
    !crypto.timingSafeEqual(providedSig, expectedSig)
  ) {
    return { valid: false, reason: 'bad-signature' };
  }

  let claims: PreflightClaims;
  try {
    const json = base64urlDecode(payloadB64).toString('utf8');
    claims = JSON.parse(json) as PreflightClaims;
  } catch {
    return { valid: false, reason: 'invalid-payload' };
  }

  if (!isWellFormedClaims(claims)) {
    return { valid: false, reason: 'invalid-payload' };
  }

  if (typeof claims.expiresAt !== 'number' || claims.expiresAt < nowMs) {
    return { valid: false, reason: 'expired' };
  }

  return { valid: true, claims };
}

/**
 * Extract claims from a token WITHOUT verifying the signature. Only use
 * for logging / tracing / fail-open audit records where we want the
 * caller-supplied context even if verification fails. Never use for
 * authorization decisions.
 */
export function extractPreflightClaims(
  token: string,
): PreflightClaims | null {
  if (typeof token !== 'string' || token.length === 0) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  try {
    const json = base64urlDecode(token.slice(0, dot)).toString('utf8');
    const parsed = JSON.parse(json) as PreflightClaims;
    return isWellFormedClaims(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function isWellFormedClaims(c: unknown): c is PreflightClaims {
  if (!c || typeof c !== 'object') return false;
  const o = c as Record<string, unknown>;
  return (
    typeof o.tenantId === 'string' &&
    typeof o.agentId === 'string' &&
    typeof o.capabilityTier === 'string' &&
    typeof o.executionEnvironment === 'string' &&
    typeof o.hitlLevel === 'number' &&
    typeof o.admissionStatus === 'string' &&
    typeof o.preflightVersion === 'string' &&
    typeof o.issuedAt === 'number' &&
    typeof o.expiresAt === 'number'
  );
}

/**
 * Deterministically derive a short version tag from the signed claim
 * set. Used for the `version` string on PreflightResponse so clients
 * can detect invalidation. Not security-sensitive — just a fingerprint.
 */
export function deriveVersionTag(input: string): string {
  return crypto.createHash('sha256').update(input).digest('hex').slice(0, 16);
}
