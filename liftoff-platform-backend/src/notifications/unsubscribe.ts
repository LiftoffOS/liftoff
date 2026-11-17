// Unsubscribe token construction + verification.
//
// Token format: `${payload}.${signature}` where payload is base64url(JSON) and
// signature is base64url(HMAC_SHA256(payload, UNSUBSCRIBE_SECRET)).
//
// Two URL builders:
//   • buildEmailUnsubscribeUrl  — FRONTEND URL with ?unsubscribe_token=...
//     (in-body link — GlobalUnsubscribeHandler picks it up, shows toast)
//   • buildListUnsubscribeUrl   — BACKEND URL POST endpoint
//     (List-Unsubscribe header — Gmail/Apple one-click)

import * as crypto from 'crypto';

const TOKEN_TTL_SECONDS = 90 * 24 * 60 * 60;  // 90 days

// All three accessors are intentionally lazy: UNSUBSCRIBE_SECRET is loaded
// from Secret Manager via initSecrets() before the HTTP server boots but
// AFTER this module is evaluated at import time, so module-load constants
// would capture an empty string. FRONTEND_URL/BACKEND_URL are Cloud Run env
// vars (available at import) but kept lazy for symmetry and to allow tests
// to override per-call. Matches plan §7b.
const SECRET = (): string => process.env.UNSUBSCRIBE_SECRET ?? '';
const FRONTEND_URL = (): string => process.env.FRONTEND_URL ?? 'https://example.com';
const BACKEND_URL = (): string => process.env.BACKEND_URL ?? 'https://api.example.com';

export type UnsubscribeAction =
  | 'disable:taskUpdates'
  | 'disable:teamActivity'
  | 'disable:escalations'
  | 'disable:weeklyDigest'
  | 'disable:newsletter'
  | 'cadence:none';

const VALID_ACTIONS = new Set<UnsubscribeAction>([
  'disable:taskUpdates',
  'disable:teamActivity',
  'disable:escalations',
  'disable:weeklyDigest',
  'disable:newsletter',
  'cadence:none',
]);

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function buildUnsubscribeToken(accountId: string, action: UnsubscribeAction): string {
  // Refuse to issue tokens with an empty HMAC key. crypto.createHmac accepts
  // '' without error, but a token signed with the empty string is trivially
  // forgeable by anyone who notices the secret is unconfigured. This throw
  // surfaces at the first email-send attempt; the caller (enqueueNotification)
  // catches it, marks delivery_error on the row, and skips sending.
  const secret = SECRET();
  if (!secret) {
    throw new Error(
      'UNSUBSCRIBE_SECRET is not configured — refusing to issue unsigned unsubscribe tokens. ' +
        'Create the `unsubscribe-secret` secret in GCP Secret Manager and grant secretAccessor ' +
        'to the platform-backend service account.',
    );
  }
  const payload = base64url(
    JSON.stringify({ aid: accountId, act: action, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS }),
  );
  const sig = base64url(crypto.createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${sig}`;
}

export function buildEmailUnsubscribeUrl(accountId: string, action: UnsubscribeAction): string {
  // Email link → FRONTEND. The global handler there picks up the token.
  return `${FRONTEND_URL()}/?unsubscribe_token=${buildUnsubscribeToken(accountId, action)}`;
}

export function buildListUnsubscribeUrl(accountId: string, action: UnsubscribeAction): string {
  // List-Unsubscribe header (Gmail/Apple one-click) → BACKEND directly.
  return `${BACKEND_URL()}/api/notifications/unsubscribe-direct?token=${buildUnsubscribeToken(accountId, action)}`;
}

export function verifyAndDecodeToken(token: string): { accountId: string; action: UnsubscribeAction } | null {
  // Symmetric to buildUnsubscribeToken — if the secret was never configured we
  // refuse to authenticate any token rather than HMAC-verify against ''.
  const secret = SECRET();
  if (!secret) return null;

  const dot = token.indexOf('.');
  if (dot < 0) return null;
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = base64url(crypto.createHmac('sha256', secret).update(payload).digest());
  if (Buffer.byteLength(expected) !== Buffer.byteLength(sig)) return null;
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return null;

  let parsed: { aid?: string; act?: string; exp?: number };
  try {
    parsed = JSON.parse(
      Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    );
  } catch {
    return null;
  }

  if (!parsed.aid || !parsed.act || !parsed.exp) return null;
  if (parsed.exp < Math.floor(Date.now() / 1000)) return null;
  if (!VALID_ACTIONS.has(parsed.act as UnsubscribeAction)) return null;
  return { accountId: parsed.aid, action: parsed.act as UnsubscribeAction };
}
