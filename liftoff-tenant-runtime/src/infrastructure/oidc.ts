// Verify the OIDC token Google Cloud Scheduler / Tasks attached to a request.
// Used by every endpoint that's only callable from Cloud Scheduler or Tasks —
// the OIDC audience must match this service's URL, and the token must be
// signed by Google's public keys.
//
// Optional second-layer SA-allowlist: cloud-tasks-handler historically pinned
// the caller email to a known set of service accounts
// (CLOUD_TASKS_SERVICE_ACCOUNT / CLOUD_SCHEDULER_SERVICE_ACCOUNT /
// `${GCP_PROJECT_NUMBER}@cloudtasks.gserviceaccount.com`). Pass
// `allowedServiceAccounts` to enforce that — when set and non-empty, tokens
// from accounts outside the list are rejected. Without it, only the issuer
// and audience are verified.

import type { Request } from 'express';
import { OAuth2Client } from 'google-auth-library';
import { logger } from './logging';
import { getTenantRuntimeUrl } from './runtime-env';

const oidcClient = new OAuth2Client();

// Match the existing implementation byte-for-byte (scheduled-invoke-handler.ts:30-67
// and cloud-tasks-handler.ts:35-67). The issuer validation is critical — without
// it an arbitrary OIDC issuer would pass verification.
const VALID_ISSUERS = ['https://accounts.google.com', 'accounts.google.com'];

export interface VerifyOidcOptions {
  // If non-empty, the OIDC payload's `email` claim must match one of these
  // exact strings. Used by cloud-tasks-handler to constrain the caller to the
  // Cloud Tasks / Scheduler service accounts configured for this project.
  allowedServiceAccounts?: Array<string | undefined | null>;
  // When true, a mismatch on the SA allowlist downgrades to a warning rather
  // than a rejection. Used to preserve dev ergonomics where the local SA
  // doesn't match the prod allowlist. Mirrors the pre-refactor
  // `process.env.ENVIRONMENT !== 'dev'` carve-out in cloud-tasks-handler.
  allowDevBypass?: boolean;
}

/**
 * Mint a Cloud Run OIDC ID token via the metadata server. The audience must
 * match the target Cloud Run service URL — Cloud Run validates it against the
 * caller-SA's roles/run.invoker binding on the target.
 *
 * Tokens are cached per-audience and reused until they're within a 60 s
 * skew window of their `exp` claim. Metadata-server round-trips run ~50 ms
 * each, so caching is the difference between a 5 ms and 55 ms /v2/execute
 * client call. Returns undefined when the metadata server is unreachable.
 */
const oidcTokenCache = new Map<string, { token: string; expiresAtMs: number }>();
const OIDC_EXPIRY_SKEW_MS = 60_000;

function decodeJwtExpiryMs(token: string): number | null {
  const dot1 = token.indexOf('.');
  const dot2 = token.indexOf('.', dot1 + 1);
  if (dot1 < 0 || dot2 < 0) return null;
  try {
    const payload = JSON.parse(
      Buffer.from(token.slice(dot1 + 1, dot2), 'base64url').toString('utf8'),
    ) as { exp?: number };
    return typeof payload.exp === 'number' ? payload.exp * 1000 : null;
  } catch {
    return null;
  }
}

export async function mintRuntimeOidc(audience: string): Promise<string | undefined> {
  const now = Date.now();
  const cached = oidcTokenCache.get(audience);
  if (cached && cached.expiresAtMs - OIDC_EXPIRY_SKEW_MS > now) {
    return cached.token;
  }
  try {
    const url = `http://metadata.google.internal/computeMetadata/v1/instance/service-accounts/default/identity?audience=${encodeURIComponent(audience)}`;
    const res = await fetch(url, {
      headers: { 'Metadata-Flavor': 'Google' },
      signal: AbortSignal.timeout(3000),
    });
    if (!res.ok) return undefined;
    const token = (await res.text()).trim();
    const expiresAtMs = decodeJwtExpiryMs(token) ?? now + 55 * 60 * 1000;
    oidcTokenCache.set(audience, { token, expiresAtMs });
    return token;
  } catch {
    return undefined;
  }
}

export async function verifyOidcToken(req: Request, options?: VerifyOidcOptions): Promise<boolean> {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    logger.warn('Missing or invalid authorization header for Cloud Scheduler');
    return false;
  }
  const token = authHeader.substring(7);
  try {
    const ticket = await oidcClient.verifyIdToken({
      idToken: token,
      audience: getTenantRuntimeUrl(),
    });
    const payload = ticket.getPayload();
    if (!payload) {
      logger.warn('Invalid OIDC token payload');
      return false;
    }
    if (!VALID_ISSUERS.includes(payload.iss || '')) {
      logger.warn({ issuer: payload.iss }, 'Invalid OIDC token issuer');
      return false;
    }
    if (options?.allowedServiceAccounts && options.allowedServiceAccounts.length > 0) {
      const allowed = options.allowedServiceAccounts.filter((s): s is string => !!s);
      const email = payload.email || '';
      if (allowed.length > 0 && !allowed.includes(email)) {
        if (options.allowDevBypass) {
          logger.warn({ email }, 'OIDC token from unexpected service account (dev bypass enabled, allowing)');
        } else {
          logger.warn({ email }, 'OIDC token from unexpected service account — rejected');
          return false;
        }
      }
    }
    logger.info({ email: payload.email }, 'Cloud Scheduler OIDC token verified');
    return true;
  } catch (err) {
    logger.warn({ err: (err as Error).message }, 'OIDC verification failed');
    return false;
  }
}
