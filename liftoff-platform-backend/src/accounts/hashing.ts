// Identifier hashes used by user-initiated account deletion + abuse-prevention.
// SHA-256 is irreversible; the resulting hex string is the only form of the
// email / phone that survives soft-scrub, written to accounts_deletion_ledger
// and to the Stripe customer's metadata.email_sha256.

import { createHash } from 'node:crypto';

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function hashEmail(email: string): string {
  return sha256(email.toLowerCase().trim());
}

export function hashPhone(phone: string): string {
  // E.164-ish normalization: strip everything non-digit. Good enough for
  // collision detection without full libphonenumber.
  return sha256(phone.replace(/\D/g, ''));
}
