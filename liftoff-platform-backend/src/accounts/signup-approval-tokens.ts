// Signup-approval token construction + verification.
//
// Token format: `${payload}.${signature}` where payload is base64url(JSON) and
// signature is base64url(HMAC_SHA256(payload, SIGNUP_APPROVAL_SECRET)).
//
// The token identifies WHICH signup a decision is being made on; it carries no
// action. The Approve/Waitlist choice is made on the authenticated
// /signup-approval page (mirrors the OAuth-consent request_id pattern). This
// mirrors the HMAC + lazy-secret design of src/notifications/unsubscribe.ts.

import * as crypto from 'crypto';

const TOKEN_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days

// Lazy: SIGNUP_APPROVAL_SECRET is loaded from Secret Manager via initSecrets()
// before the HTTP server boots but AFTER this module is evaluated at import
// time, so a module-load constant would capture an empty string.
const SECRET = (): string => process.env.SIGNUP_APPROVAL_SECRET ?? '';

function base64url(input: string | Buffer): string {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function buildSignupApprovalToken(accountId: string): string {
  // Refuse to issue tokens with an empty HMAC key. crypto.createHmac accepts
  // '' without error, but a token signed with the empty string is trivially
  // forgeable by anyone who notices the secret is unconfigured. This throw
  // surfaces at the first email-send attempt; sendSignupNotification is
  // best-effort and logs the failure without blocking signup.
  const secret = SECRET();
  if (!secret) {
    throw new Error(
      'SIGNUP_APPROVAL_SECRET is not configured — refusing to issue unsigned signup-approval tokens. ' +
        'Create the `signup-approval-secret` secret in GCP Secret Manager and grant secretAccessor ' +
        'to the platform-backend service account.',
    );
  }
  const payload = base64url(
    JSON.stringify({ aid: accountId, exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS }),
  );
  const sig = base64url(crypto.createHmac('sha256', secret).update(payload).digest());
  return `${payload}.${sig}`;
}

// Verification result. `expired` is distinguished from `invalid` (bad
// signature / malformed / unconfigured secret) so callers can return 410 vs 400
// and the approval page can show a precise "link expired" state.
export type SignupApprovalTokenResult =
  | { ok: true; accountId: string }
  | { ok: false; reason: 'invalid' | 'expired' };

export function verifySignupApprovalToken(token: string): SignupApprovalTokenResult {
  // Symmetric to buildSignupApprovalToken — if the secret was never configured
  // we refuse to authenticate any token rather than HMAC-verify against ''.
  const secret = SECRET();
  if (!secret) return { ok: false, reason: 'invalid' };

  const dot = token.indexOf('.');
  if (dot < 0) return { ok: false, reason: 'invalid' };
  const payload = token.slice(0, dot);
  const sig = token.slice(dot + 1);

  const expected = base64url(crypto.createHmac('sha256', secret).update(payload).digest());
  if (Buffer.byteLength(expected) !== Buffer.byteLength(sig)) return { ok: false, reason: 'invalid' };
  if (!crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(sig))) return { ok: false, reason: 'invalid' };

  let parsed: { aid?: string; exp?: number };
  try {
    parsed = JSON.parse(
      Buffer.from(payload.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8'),
    );
  } catch {
    return { ok: false, reason: 'invalid' };
  }

  // A validly-signed token whose payload is missing fields is a malformed token,
  // not an expired one.
  if (!parsed.aid || !parsed.exp) return { ok: false, reason: 'invalid' };
  if (parsed.exp < Math.floor(Date.now() / 1000)) return { ok: false, reason: 'expired' };
  return { ok: true, accountId: parsed.aid };
}
