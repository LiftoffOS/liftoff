// Sidecar shared-secret auth (ported from tenant-runtime/src/security/sidecar-secret.ts).
//
// MCP sidecars in the connector-service process add this header to outbound
// requests; the sidecar HTTP handler validates it with a constant-time compare.
// The secret rotates on every process restart.

import { randomBytes, timingSafeEqual } from 'crypto';

/** 64-character hex string (32 bytes of entropy) generated at process start. */
export const SIDECAR_SECRET = randomBytes(32).toString('hex');

/** HTTP request header name used for sidecar auth. */
export const SIDECAR_AUTH_HEADER = 'X-Sidecar-Auth';

export function validateSidecarAuth(headerValue: string | string[] | undefined): boolean {
  if (!headerValue || Array.isArray(headerValue)) {
    return false;
  }
  try {
    const expected = Buffer.from(SIDECAR_SECRET, 'utf8');
    const received = Buffer.from(headerValue, 'utf8');
    if (expected.length !== received.length) {
      return false;
    }
    return timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}
