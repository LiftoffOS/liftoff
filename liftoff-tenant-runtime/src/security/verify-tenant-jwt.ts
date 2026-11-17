// Tenant JWT Verifier (Phase 4A)
//
// Verifies the Platform Backend's OIDC-signed tenant-context JWT. The Platform
// Backend signs a short-lived JWT on every cross-service call that binds a
// request to (tenantId, agentId?, invocationId?) — the tenant runtime uses
// this as the authoritative source of the request's tenant identity, not
// any header or body field the caller could forge.
//
// Security properties we enforce:
//   1. Signature validation against the backend's OIDC public key (JWKS).
//   2. Explicit algorithm allow-list (RS256 / ES256); `alg: none` rejected.
//   3. Audience MUST be in the allow-list (this tenant runtime's expected
//      audience) — prevents token replay against a different service.
//   4. Issuer MUST match the configured backend.
//   5. Expiry enforced; `exp` required (no indefinite tokens).
//   6. Subject required (so we can attribute actions).
//
// The claims returned here are then used to populate the TenantContext via
// runWithTenantContext. Every sensitive code path downstream asserts
// tenantId matches the active context, so a forged token that somehow gets
// past signature verification still can't reach cross-tenant data.

import { jwtVerify, createRemoteJWKSet, type JWTPayload } from 'jose';
import { logger } from '../infrastructure/logging';

/**
 * Thrown when a JWT fails verification. The `reason` codes are stable for
 * tests and external log consumers; the `message` is human-readable. Never
 * include the raw token in the error message — it's a bearer credential.
 */
export class TenantJwtVerificationError extends Error {
  public readonly reason:
    | 'missing'
    | 'malformed'
    | 'alg_none'
    | 'bad_signature'
    | 'expired'
    | 'bad_audience'
    | 'bad_issuer'
    | 'missing_tenant_claim'
    | 'missing_subject'
    | 'jwks_fetch_failed';

  constructor(reason: TenantJwtVerificationError['reason'], message: string) {
    super(message);
    this.name = 'TenantJwtVerificationError';
    this.reason = reason;
  }
}

/**
 * Verified claims we extract from the tenant-context JWT.
 */
export interface VerifiedTenantClaims {
  tenantId: string;
  agentId?: string;
  invocationId?: string;
  sub: string;
  aud: string | string[];
  iss: string;
  exp: number;
}

/**
 * Configuration for the verifier. Everything except the JWKS URI is
 * configurable per-deployment; the JWKS URI is derived from the issuer by
 * default (standard OIDC discovery pattern).
 */
export interface TenantJwtVerifierConfig {
  /** JWKS endpoint of the Platform Backend. Example:
   *  `https://api.example.com/.well-known/jwks.json` */
  jwksUri: string;
  /** Expected issuer. Example: `https://api.example.com` */
  issuer: string;
  /** Allow-list of acceptable audiences. Example:
   *  `['tenant-runtime', 'https://tenant-runtime.run.app']` */
  allowedAudiences: string[];
  /** Signature algorithms we accept. Defaults to `['RS256', 'ES256']`.
   *  `none` is NEVER included — we explicitly reject it in assertAlg. */
  allowedAlgorithms?: string[];
  /** Clock skew tolerance in seconds. Defaults to 30. */
  clockToleranceSec?: number;
}

// Cache remote JWKS per jwksUri. jose maintains its own key cache, so this
// is only here to avoid rebuilding the fetcher/verifier on every call.
const jwksCache = new Map<string, ReturnType<typeof createRemoteJWKSet>>();

function getJwks(jwksUri: string): ReturnType<typeof createRemoteJWKSet> {
  const existing = jwksCache.get(jwksUri);
  if (existing) return existing;
  const jwks = createRemoteJWKSet(new URL(jwksUri));
  jwksCache.set(jwksUri, jwks);
  return jwks;
}

/**
 * Test hook — reset the JWKS cache. Used by unit tests that install a mock
 * JWKS fetcher via `setJwksForTesting`.
 */
export function __resetJwksCacheForTests(): void {
  jwksCache.clear();
}

/**
 * Test hook — inject a JWKS verifier for a given URI. Used by unit tests so
 * they don't need a real HTTP endpoint. Do NOT call this from production.
 */
export function __setJwksForTesting(
  jwksUri: string,
  verifier: ReturnType<typeof createRemoteJWKSet>,
): void {
  jwksCache.set(jwksUri, verifier);
}

/**
 * Reject tokens whose header alg is `none`. jose's jwtVerify enforces this
 * too if you pass `algorithms`, but we do an explicit string check first so
 * the failure mode is unambiguous in tests and logs.
 */
function assertAlgNotNone(token: string): void {
  const firstDot = token.indexOf('.');
  if (firstDot === -1) {
    throw new TenantJwtVerificationError('malformed', 'Token is not a compact JWS');
  }
  const headerB64 = token.slice(0, firstDot);
  let header: { alg?: string };
  try {
    // Use Buffer — works in Node (runtime target). jose ships a browser-safe
    // base64url decoder but the Node path is fine here.
    const json = Buffer.from(headerB64, 'base64url').toString('utf8');
    header = JSON.parse(json);
  } catch {
    throw new TenantJwtVerificationError('malformed', 'Token header is not valid base64url JSON');
  }
  if (!header.alg || typeof header.alg !== 'string') {
    throw new TenantJwtVerificationError('malformed', 'Token header missing alg');
  }
  if (header.alg.toLowerCase() === 'none') {
    throw new TenantJwtVerificationError('alg_none', 'alg=none is not permitted');
  }
}

/**
 * Verify a tenant-context JWT. Throws `TenantJwtVerificationError` on any
 * failure. On success returns the extracted claims.
 */
export async function verifyTenantJwt(
  token: string | undefined,
  config: TenantJwtVerifierConfig,
): Promise<VerifiedTenantClaims> {
  if (!token || typeof token !== 'string') {
    throw new TenantJwtVerificationError('missing', 'No JWT provided');
  }

  assertAlgNotNone(token);

  const allowedAlgorithms = config.allowedAlgorithms ?? ['RS256', 'ES256'];
  if (allowedAlgorithms.includes('none' as string)) {
    // Belt + suspenders: even if a caller passes a config with 'none', refuse.
    throw new TenantJwtVerificationError('alg_none', 'alg=none is not permitted (config guard)');
  }

  const jwks = getJwks(config.jwksUri);

  let payload: JWTPayload;
  try {
    const result = await jwtVerify(token, jwks, {
      issuer: config.issuer,
      audience: config.allowedAudiences,
      algorithms: allowedAlgorithms,
      clockTolerance: config.clockToleranceSec ?? 30,
      requiredClaims: ['exp', 'iss', 'aud', 'sub'],
    });
    payload = result.payload;
  } catch (err) {
    const code = (err as { code?: string })?.code;
    const msg = (err as Error)?.message ?? 'unknown';
    // Map jose's error codes to our stable reasons.
    if (code === 'ERR_JWT_EXPIRED' || /exp/i.test(msg)) {
      throw new TenantJwtVerificationError('expired', 'Token expired');
    }
    if (code === 'ERR_JWT_CLAIM_VALIDATION_FAILED') {
      if (/audience/i.test(msg)) {
        throw new TenantJwtVerificationError('bad_audience', `Audience mismatch: ${msg}`);
      }
      if (/issuer/i.test(msg)) {
        throw new TenantJwtVerificationError('bad_issuer', `Issuer mismatch: ${msg}`);
      }
    }
    if (code === 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED' || /signature/i.test(msg)) {
      throw new TenantJwtVerificationError('bad_signature', 'Signature verification failed');
    }
    if (code === 'ERR_JWKS_NO_MATCHING_KEY' || /jwks|key/i.test(msg)) {
      throw new TenantJwtVerificationError('jwks_fetch_failed', `JWKS key lookup failed: ${msg}`);
    }
    logger.warn('tenant_jwt_verify_unknown_error', { err: msg, code });
    throw new TenantJwtVerificationError('bad_signature', `JWT verification failed: ${msg}`);
  }

  // Extract tenant-specific claims. These are custom claims under a
  // namespaced key so they don't collide with the standard OIDC claims.
  const tenantId =
    (payload as Record<string, unknown>)['tenant_id'] ??
    (payload as Record<string, unknown>)['tenantId'];
  if (!tenantId || typeof tenantId !== 'string') {
    throw new TenantJwtVerificationError(
      'missing_tenant_claim',
      'Token missing required tenant_id claim',
    );
  }

  const agentId =
    (payload as Record<string, unknown>)['agent_id'] ??
    (payload as Record<string, unknown>)['agentId'];
  const invocationId =
    (payload as Record<string, unknown>)['invocation_id'] ??
    (payload as Record<string, unknown>)['invocationId'];

  if (!payload.sub) {
    throw new TenantJwtVerificationError('missing_subject', 'Token missing sub claim');
  }
  if (!payload.exp) {
    // jwtVerify's requiredClaims already enforces this, but defense in depth.
    throw new TenantJwtVerificationError('expired', 'Token missing exp claim');
  }
  if (!payload.aud) {
    throw new TenantJwtVerificationError('bad_audience', 'Token missing aud claim');
  }
  if (!payload.iss) {
    throw new TenantJwtVerificationError('bad_issuer', 'Token missing iss claim');
  }

  return {
    tenantId,
    agentId: typeof agentId === 'string' ? agentId : undefined,
    invocationId: typeof invocationId === 'string' ? invocationId : undefined,
    sub: payload.sub,
    aud: payload.aud,
    iss: payload.iss,
    exp: payload.exp,
  };
}
