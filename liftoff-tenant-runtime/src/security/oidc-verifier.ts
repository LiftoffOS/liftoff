// Google OIDC bearer-token verifier.
//
// Phase 4: intra-tenant calls between the
// four split Cloud Run services (agent, coordinator, tool-gateway, reflection)
// use OIDC tokens minted by the Cloud Run metadata server instead of (or in
// addition to) the shared X-Service-Auth bearer. This module verifies an
// inbound OIDC token against Google's public keys and returns the decoded
// payload.
//
// Used by `requireServiceAuth({ acceptOidc: true, ... })` in service-auth.ts.
// Factored out so it can be unit-tested without pulling Express in.

import { OAuth2Client, type TokenPayload } from 'google-auth-library';

// Share one OAuth2Client for the process — it caches Google's public keys
// internally and refreshes them as needed. Recreating per-request is wasteful
// and causes extra JWKS fetches.
let sharedClient: OAuth2Client | null = null;
function getClient(): OAuth2Client {
  if (!sharedClient) sharedClient = new OAuth2Client();
  return sharedClient;
}

export interface VerifyOidcOptions {
  /**
   * Expected OIDC `aud` claim. Cloud Run OIDC tokens bound to a target
   * service have `aud` == that service's URL (no trailing slash). Pass the
   * same URL the token was minted for.
   */
  audience: string | string[];
  /**
   * Allow-list of service-account emails. The token's `email` claim must
   * match one of these exactly. This is the primary authorisation check —
   * without it, any Google-signed OIDC token would pass.
   */
  allowedEmails: string[];
  /**
   * Optional: allow emails whose `email_verified` claim is false. Default
   * false. Google-signed service-account tokens always have
   * `email_verified: true`, so this should stay false in prod.
   */
  allowUnverifiedEmail?: boolean;
}

export type OidcVerifyResult =
  | { ok: true; payload: TokenPayload }
  | { ok: false; reason: string };

/**
 * Parse an `Authorization: Bearer <token>` header and return the raw JWT.
 * Returns `null` if the header is missing or malformed. Leading/trailing
 * whitespace is trimmed; the scheme match is case-insensitive to match
 * RFC 6750.
 */
export function extractBearerToken(authHeader: string | undefined): string | null {
  if (!authHeader) return null;
  const m = authHeader.trim().match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const token = m[1].trim();
  return token.length > 0 ? token : null;
}

/**
 * Verify a Google-issued OIDC ID token. Uses the shared OAuth2Client which
 * caches Google's public keys. On success, returns the decoded payload; on
 * any failure (bad signature, wrong audience, expired, wrong email,
 * unverified email) returns a structured `reason`.
 *
 * This function never throws — every error path returns `{ ok: false, reason }`.
 * That matches Express middleware's shape (return 401 with a stable error body).
 */
export async function verifyGoogleOidcToken(
  token: string,
  opts: VerifyOidcOptions,
): Promise<OidcVerifyResult> {
  const client = getClient();

  let ticket;
  try {
    ticket = await client.verifyIdToken({
      idToken: token,
      audience: opts.audience,
    });
  } catch (err) {
    return { ok: false, reason: `oidc_verify_failed: ${(err as Error).message}` };
  }

  const payload = ticket.getPayload();
  if (!payload) {
    return { ok: false, reason: 'oidc_payload_missing' };
  }

  const iss = payload.iss;
  if (iss !== 'https://accounts.google.com' && iss !== 'accounts.google.com') {
    return { ok: false, reason: `oidc_unexpected_issuer: ${iss}` };
  }

  const email = payload.email;
  if (!email) {
    return { ok: false, reason: 'oidc_email_missing' };
  }

  if (!opts.allowUnverifiedEmail && payload.email_verified !== true) {
    return { ok: false, reason: 'oidc_email_not_verified' };
  }

  if (!opts.allowedEmails.includes(email)) {
    return { ok: false, reason: `oidc_email_not_allowed: ${email}` };
  }

  return { ok: true, payload };
}

/**
 * Reset the shared OAuth2Client. For tests only — production code should
 * let the singleton live for the process lifetime.
 */
export function resetOidcVerifierClientForTests(): void {
  sharedClient = null;
}

/**
 * Replace the shared client with a test double. For tests only.
 */
export function setOidcVerifierClientForTests(client: OAuth2Client): void {
  sharedClient = client;
}
