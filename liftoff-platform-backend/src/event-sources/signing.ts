// HMAC-SHA256 signature verification for inbound custom-event webhooks.
//
// Header format: X-Liftoff-Signature: t=<unix_seconds>,v1=<hex_hmac_sha256>
//
// Signed payload is `${t}.${rawBody}` where rawBody is the raw Buffer from
// express.raw — never the re-serialized JSON. Timestamps older than 300s
// are rejected to prevent replay. Comparison is timing-safe.

import crypto from 'crypto';

const REPLAY_WINDOW_SECONDS = 300;

export interface SignatureParseResult {
  timestamp: number;
  signature: string;
}

/** Parse `t=<unix>,v1=<hex>`. Returns null on malformed input. */
export function parseSignatureHeader(header: string | undefined): SignatureParseResult | null {
  if (!header) return null;
  const parts = header.split(',').map(p => p.trim());
  let timestamp: number | null = null;
  let signature: string | null = null;
  for (const part of parts) {
    const eq = part.indexOf('=');
    if (eq < 0) continue;
    const key = part.slice(0, eq);
    const value = part.slice(eq + 1);
    if (key === 't') {
      const parsed = parseInt(value, 10);
      if (!Number.isNaN(parsed)) timestamp = parsed;
    } else if (key === 'v1') {
      signature = value;
    }
  }
  if (timestamp === null || signature === null) return null;
  return { timestamp, signature };
}

export interface VerifyResult {
  valid: boolean;
  /** Set when the signature is invalid; one of the standard `event_deliveries.status` rejection strings. */
  reason?: 'rejected_signature';
}

export function verifySignature(
  rawBody: Buffer,
  header: string | undefined,
  signingSecret: string,
  nowEpochSeconds: number = Math.floor(Date.now() / 1000),
): VerifyResult {
  const parsed = parseSignatureHeader(header);
  if (!parsed) return { valid: false, reason: 'rejected_signature' };

  if (nowEpochSeconds - parsed.timestamp > REPLAY_WINDOW_SECONDS) {
    return { valid: false, reason: 'rejected_signature' };
  }
  // Reject far-future timestamps too — protects against clock-skew abuse.
  if (parsed.timestamp - nowEpochSeconds > REPLAY_WINDOW_SECONDS) {
    return { valid: false, reason: 'rejected_signature' };
  }

  const baseString = Buffer.concat([
    Buffer.from(`${parsed.timestamp}.`),
    rawBody,
  ]);
  const expected = crypto
    .createHmac('sha256', signingSecret)
    .update(baseString)
    .digest('hex');

  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(parsed.signature, 'utf8');
  if (a.length !== b.length) return { valid: false, reason: 'rejected_signature' };
  if (!crypto.timingSafeEqual(a, b)) return { valid: false, reason: 'rejected_signature' };
  return { valid: true };
}

/** Generate a fresh 32-byte hex signing secret. */
export function generateSigningSecret(): string {
  return crypto.randomBytes(32).toString('hex');
}

/** Generate a 32-byte URL-safe token (base64url, no padding). */
export function generateUrlToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

/** Last-4 hint used in the UI ("...a1b2") without revealing the secret. */
export function secretHint(secret: string): string {
  return secret.slice(-4);
}
