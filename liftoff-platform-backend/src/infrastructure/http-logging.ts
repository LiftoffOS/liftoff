/**
 * Shared redacting HTTP logger (SE-011)
 *
 * Sanitizes sensitive headers before logging. Used by TenantRuntimeClient
 * and any other outbound HTTP client that carries auth tokens.
 *
 * Redacted patterns:
 *   - X-Service-Auth → <redacted>
 *   - Authorization: Bearer <token> → Authorization: Bearer <redacted>
 *   - Any header whose value matches a JWT pattern (eyJ...) → <redacted>
 *   - URL query params: ?token=... → ?token=<redacted>
 */

import { log } from './logging';

const SENSITIVE_HEADERS = new Set([
  'x-service-auth',
  'authorization',
  'x-api-key',
  'cookie',
]);

const JWT_PATTERN = /^eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/;

/**
 * Redact sensitive values from a headers object.
 * Returns a new object safe for logging — does NOT mutate the original.
 */
export function redactHeaders(
  headers: Record<string, string | undefined>,
): Record<string, string> {
  const redacted: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    if (!value) continue;

    const lower = key.toLowerCase();
    if (SENSITIVE_HEADERS.has(lower)) {
      // Preserve the "Bearer " prefix for Authorization so log readers
      // know the auth scheme, but redact the actual token.
      if (lower === 'authorization' && value.startsWith('Bearer ')) {
        redacted[key] = 'Bearer <redacted>';
      } else {
        redacted[key] = '<redacted>';
      }
    } else if (JWT_PATTERN.test(value)) {
      redacted[key] = '<redacted-jwt>';
    } else {
      redacted[key] = value;
    }
  }

  return redacted;
}

/**
 * Redact sensitive query parameters from a URL string.
 * Handles ?token=, ?key=, ?secret=, ?password= patterns.
 */
export function redactUrl(url: string): string {
  return url.replace(
    /([?&])(token|key|secret|password|api_key)=([^&]+)/gi,
    '$1$2=<redacted>',
  );
}

/**
 * Log an outbound HTTP request with redacted headers and URL.
 */
export function logOutboundRequest(
  method: string,
  url: string,
  headers: Record<string, string | undefined>,
  context?: Record<string, unknown>,
): void {
  log.debug({
    ...context,
    method,
    url: redactUrl(url),
    headers: redactHeaders(headers),
  }, 'Outbound HTTP request');
}
