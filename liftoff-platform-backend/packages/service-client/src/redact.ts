// Redact sensitive values from headers and URLs before they hit any log.
//
// Redaction is boringly conservative — lowercased name match against a
// deny-list. Services can extend the deny-list via options without forking
// the util.

const DEFAULT_SENSITIVE_HEADER_NAMES = new Set<string>([
  'authorization',
  'x-service-auth',
  'cookie',
  'set-cookie',
  'x-api-key',
  'api-key',
  'proxy-authorization',
]);

const DEFAULT_SENSITIVE_QUERY_PARAMS = new Set<string>([
  'access_token',
  'refresh_token',
  'id_token',
  'code',
  'client_secret',
  'api_key',
  'apikey',
  'token',
  'key',
  'secret',
]);

export interface RedactionOptions {
  extraHeaderNames?: string[];
  extraQueryParams?: string[];
  replacement?: string;
}

export function redactHeaders(
  headers: Record<string, string | string[] | undefined>,
  options: RedactionOptions = {},
): Record<string, string | string[] | undefined> {
  const deny = new Set(DEFAULT_SENSITIVE_HEADER_NAMES);
  for (const h of options.extraHeaderNames ?? []) deny.add(h.toLowerCase());
  const replacement = options.replacement ?? '[REDACTED]';

  const out: Record<string, string | string[] | undefined> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = deny.has(name.toLowerCase()) ? replacement : value;
  }
  return out;
}

/**
 * Redact sensitive query parameters from a URL. Returns the URL string
 * with the flagged params replaced by `[REDACTED]`. Non-URL input is
 * returned unchanged.
 */
export function redactUrl(url: string, options: RedactionOptions = {}): string {
  const deny = new Set(DEFAULT_SENSITIVE_QUERY_PARAMS);
  for (const p of options.extraQueryParams ?? []) deny.add(p.toLowerCase());
  const replacement = options.replacement ?? '[REDACTED]';

  try {
    const parsed = new URL(url);
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (deny.has(key.toLowerCase())) {
        parsed.searchParams.set(key, replacement);
      }
    }
    return parsed.toString();
  } catch {
    return url;
  }
}
