// Token Security [BE-002+SE-002]
// Cryptographically secure token generation and verification

import crypto from 'crypto';

// Generate cryptographically secure token
export function generateInviteToken(): string {
  return crypto.randomBytes(32).toString('base64url');
}

// Hash token for storage (never store plaintext)
export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

// Verify token against hash
export function verifyToken(token: string, hash: string): boolean {
  const tokenHash = hashToken(token);
  return crypto.timingSafeEqual(Buffer.from(tokenHash), Buffer.from(hash));
}
