// Phase 0j — cross-service authentication contract. Every cross-service
// call carries BOTH:
//
//   1. `X-Service-Auth: <per-callee-secret>` — separate secret per callee
//      (not a shared global). Per-callee secret is fetched from Secret
//      Manager via a DI lookup function so the SDK stays vendor-neutral.
//   2. `Authorization: Bearer <oidc>` — Google OIDC ID token with `aud`
//      = callee's Cloud Run URL. Cloud Run IAM validates at the edge;
//      this SDK layer re-verifies `iss` + `aud` + expected caller SA
//      in-app.
//
// Negative cases covered by tests:
//   - Replayed OIDC with wrong audience → rejected
//   - Replayed OIDC across services → rejected (aud mismatch)
//   - Missing X-Service-Auth → rejected
//   - Wrong X-Service-Auth → rejected
//   - OIDC from unexpected SA → rejected

import type { Request, Response, NextFunction } from 'express';
import { timingSafeEqual } from 'node:crypto';

/** Fetches the per-callee secret at request time — backed by Secret Manager in prod. */
export type PerCalleeSecretLookup = (calleeId: string) => Promise<string | null>;

/** Verifies + decodes an OIDC token. Provided by caller — typically wraps google-auth-library. */
export interface OidcVerifier {
  /**
   * Verify the token signature + standard claims, then assert `aud`
   * and `iss` match the supplied expected values. Throws on failure.
   * Returns the decoded payload for downstream checks.
   */
  verify(token: string, expectedAudience: string, expectedIssuer?: string): Promise<OidcPayload>;
}

export interface OidcPayload {
  iss: string;
  aud: string;
  email?: string;
  sub: string;
  exp: number;
  iat: number;
  [claim: string]: unknown;
}

export interface CrossServiceAuthOptions {
  /** Callee's stable identifier, e.g. `billing` / `connector` / `workforce`. */
  calleeId: string;
  /** Fully qualified Cloud Run URL the callee expects in the OIDC `aud`. */
  expectedAudience: string;
  /** Google's `iss` claim. Defaults to `https://accounts.google.com`. */
  expectedIssuer?: string;
  /** Expected caller service account emails — whitelist check on the OIDC payload. */
  allowedCallerServiceAccounts: string[];
  /** Per-callee secret lookup. */
  secretLookup: PerCalleeSecretLookup;
  /** OIDC verifier (google-auth-library in production; mock in tests). */
  oidcVerifier: OidcVerifier;
}

export interface CrossServiceAuthOutcome {
  ok: boolean;
  reason?:
    | 'missing_service_token'
    | 'wrong_service_token'
    | 'secret_unconfigured'
    | 'missing_oidc'
    | 'invalid_oidc'
    | 'wrong_audience'
    | 'wrong_issuer'
    | 'unexpected_caller';
  payload?: OidcPayload;
}

/**
 * Callee-side validator. Returns an outcome you can translate into an
 * HTTP response; the Express factory below does that translation.
 */
export async function validateCrossServiceAuth(
  headers: Record<string, string | string[] | undefined>,
  options: CrossServiceAuthOptions,
): Promise<CrossServiceAuthOutcome> {
  const svcToken = firstHeader(headers['x-service-auth']);
  if (!svcToken) return { ok: false, reason: 'missing_service_token' };

  const expectedSecret = await options.secretLookup(options.calleeId);
  if (!expectedSecret) return { ok: false, reason: 'secret_unconfigured' };

  const expected = Buffer.from(expectedSecret);
  const provided = Buffer.from(svcToken);
  if (expected.length !== provided.length || !timingSafeEqual(expected, provided)) {
    return { ok: false, reason: 'wrong_service_token' };
  }

  const authHeader = firstHeader(headers.authorization);
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return { ok: false, reason: 'missing_oidc' };
  }
  const token = authHeader.slice('Bearer '.length);

  let payload: OidcPayload;
  try {
    payload = await options.oidcVerifier.verify(
      token,
      options.expectedAudience,
      options.expectedIssuer,
    );
  } catch {
    return { ok: false, reason: 'invalid_oidc' };
  }

  if (payload.aud !== options.expectedAudience) {
    return { ok: false, reason: 'wrong_audience' };
  }
  const expectedIss = options.expectedIssuer ?? 'https://accounts.google.com';
  if (payload.iss !== expectedIss) {
    return { ok: false, reason: 'wrong_issuer' };
  }
  const callerEmail = typeof payload.email === 'string' ? payload.email : '';
  if (!options.allowedCallerServiceAccounts.includes(callerEmail)) {
    return { ok: false, reason: 'unexpected_caller' };
  }
  return { ok: true, payload };
}

/** Express middleware factory — 401 on auth failure, attaches payload to `req.crossServiceCaller`. */
export function crossServiceAuthMiddleware(options: CrossServiceAuthOptions) {
  return async function middleware(req: Request, res: Response, next: NextFunction): Promise<void> {
    const outcome = await validateCrossServiceAuth(req.headers as Record<string, string | string[] | undefined>, options);
    if (outcome.ok) {
      (req as Request & { crossServiceCaller?: OidcPayload }).crossServiceCaller = outcome.payload;
      next();
      return;
    }
    const status = outcome.reason === 'secret_unconfigured' ? 500 : 401;
    res.status(status).json({ error: 'cross_service_auth_failed', reason: outcome.reason });
  };
}

// ── Caller side ────────────────────────────────────────────────────────

export interface OidcTokenFactory {
  /** Returns a valid ID token for the given audience. */
  forAudience(audience: string): Promise<string>;
}

export interface BuildCrossServiceHeadersOptions {
  calleeId: string;
  calleeAudience: string;
  secretLookup: PerCalleeSecretLookup;
  tokenFactory: OidcTokenFactory;
}

export async function buildCrossServiceHeaders(
  options: BuildCrossServiceHeadersOptions,
): Promise<Record<string, string>> {
  const [secret, idToken] = await Promise.all([
    options.secretLookup(options.calleeId),
    options.tokenFactory.forAudience(options.calleeAudience),
  ]);
  if (!secret) {
    throw new Error(`cross-service-auth: no secret configured for callee "${options.calleeId}"`);
  }
  return {
    'x-service-auth': secret,
    authorization: `Bearer ${idToken}`,
  };
}

function firstHeader(v: string | string[] | undefined): string | null {
  if (!v) return null;
  if (Array.isArray(v)) return v[0] ?? null;
  return v;
}
