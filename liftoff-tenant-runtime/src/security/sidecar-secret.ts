// Sidecar Shared-Secret Auth (Phase 4D)
//
// A cryptographically random secret generated once at process start. All
// outbound HTTP calls to localhost sidecar servers (http://localhost:8100/*)
// MUST include the header `X-Sidecar-Auth: <SIDECAR_SECRET>`. Sidecar
// HTTP handlers MUST reject requests that are missing or present the wrong
// value (with a constant-time compare to prevent timing attacks).
//
// Threat model: a compromised npm dependency or RCE in connector code could
// make arbitrary HTTP calls to localhost:8100 and forward tenant credentials
// to an unintended target. This shared secret ensures only code in this
// process (which knows the value) can reach the sidecar endpoints.
//
// Rotation: the secret rotates on every process restart — there is no
// external key management, no database, no Secret Manager dependency.
// In-flight requests that straddle a restart will fail with 401 and be
// retried by the caller. This is the intended behaviour.
//
// Future: this is a transitional control. When the Connector Service
// extraction ships (moving sidecar code to a separate isolated container
// communicating over a private network), this shared-secret is superseded
// by mTLS between the main runtime and the connector container.

import { randomBytes, timingSafeEqual } from 'crypto';

/** 64-character hex string (32 bytes of entropy) generated at process start. */
export const SIDECAR_SECRET = randomBytes(32).toString('hex');

/** HTTP request header name used for sidecar auth. */
export const SIDECAR_AUTH_HEADER = 'X-Sidecar-Auth';

/**
 * Validate that an inbound HTTP request carries the correct sidecar secret.
 *
 * Returns `true` if the header is present and matches SIDECAR_SECRET.
 * Returns `false` otherwise. Uses `timingSafeEqual` to prevent timing attacks.
 *
 * Usage in a sidecar HTTP handler:
 *
 *   if (!validateSidecarAuth(req.headers['x-sidecar-auth'])) {
 *     res.writeHead(401, { 'Content-Type': 'application/json' });
 *     res.end(JSON.stringify({ error: 'unauthorized', message: 'Invalid sidecar auth' }));
 *     return;
 *   }
 */
export function validateSidecarAuth(headerValue: string | string[] | undefined): boolean {
  if (!headerValue || Array.isArray(headerValue)) {
    return false;
  }
  try {
    const expected = Buffer.from(SIDECAR_SECRET, 'utf8');
    const received = Buffer.from(headerValue, 'utf8');
    // timingSafeEqual requires same-length buffers; mismatched length leaks
    // nothing other than "wrong" which is fine, but we must handle it to avoid
    // a RangeError that crashes the handler.
    if (expected.length !== received.length) {
      return false;
    }
    return timingSafeEqual(expected, received);
  } catch {
    return false;
  }
}
