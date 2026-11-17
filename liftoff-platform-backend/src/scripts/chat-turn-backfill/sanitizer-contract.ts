// Sanitizer contract for the chat-turn attribution backfill (plan v13
// Change 5). The TR exporter HMACs SANITIZED objectives; the PB matcher must
// sanitize PB message content IDENTICALLY before comparing digests. Raw
// package-version equality is not the gate (PB installs proto-gen 0.13, TR
// 0.12 — currently hash-identical redaction.js, luck not contract); instead
// both sides compute this CONTRACT FINGERPRINT — SHA-256 over the redaction
// module bytes + every constant that shapes the sanitized value — and the
// matcher ABORTS WITH ZERO WRITES on mismatch. Package versions ride along
// as diagnostic metadata only.
//
// The string path mirrors TR's audit sanitizeArgs (tenant-runtime
// src/audit/service.ts): redactPii, then truncate to MAX_VALUE_LENGTH with
// the '...[truncated]' suffix. SENSITIVE_KEYS participates in the
// fingerprint even though the objective is a plain string, because the
// exporter's sanitized value comes from the full sanitizeArgs tree walk.

import { createHash, createHmac } from 'crypto';
import { readFileSync } from 'fs';
import { redactPii } from '@liftoffos/proto-gen/dist/redaction';

export const SENSITIVE_KEYS = [
  'password', 'token', 'secret', 'key',
  'credential', 'auth', 'apikey', 'api_key',
];
export const MAX_VALUE_LENGTH = 1000;
export const TRUNCATION_SUFFIX = '...[truncated]';
export const SANITIZER_ALGORITHM_REVISION = 1;

/** Mirror of TR sanitizeArgs' string branch. */
export function sanitizeContent(value: string): string {
  const redacted = redactPii(value);
  return redacted.length > MAX_VALUE_LENGTH
    ? redacted.substring(0, MAX_VALUE_LENGTH) + TRUNCATION_SUFFIX
    : redacted;
}

/**
 * SHA-256 fingerprint of everything that shapes sanitized values: the
 * installed redaction module's bytes plus the contract constants. Computed
 * identically by the TR exporter; mismatch aborts the matcher.
 */
export function computeSanitizerFingerprint(): string {
  const redactionModulePath = require.resolve('@liftoffos/proto-gen/dist/redaction');
  const moduleBytes = readFileSync(redactionModulePath);
  const contract = JSON.stringify({
    sensitiveKeys: SENSITIVE_KEYS,
    maxValueLength: MAX_VALUE_LENGTH,
    truncationSuffix: TRUNCATION_SUFFIX,
    algorithmRevision: SANITIZER_ALGORITHM_REVISION,
  });
  return createHash('sha256').update(moduleBytes).update('\n').update(contract).digest('hex');
}

/** HMAC-SHA256 of a sanitized objective/content under the run-scoped key. */
export function hmacSanitized(runKey: Buffer, sanitized: string): string {
  return createHmac('sha256', runKey).update(sanitized, 'utf8').digest('hex');
}
