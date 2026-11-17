// Log Redactor (Phase 4I)
//
// Regex-based secret scrubber integrated with the logger. Prevents access
// tokens, refresh tokens, API keys, and service-account credentials from
// appearing in log output — whether they arrive as structured object fields
// or as raw strings embedded in error messages.
//
// Two exported functions:
//   1. `redactSecrets(obj)` — deep-walks an object and redacts matched key
//      names AND matched string values. Does NOT stringify-then-regex: walking
//      the object avoids false positives from JSON keys appearing in
//      serialised strings, and is safe for circular-reference–free objects.
//
//   2. `redactString(str)` — applies regex replacements to a raw string.
//      Used for error messages, SQL query strings, etc. that aren't objects.
//
// Wire-up: the logger's `buildEntry` path calls `redactSecrets` on every
// log entry object just before JSON serialisation.

/** Replacement sentinel used everywhere. */
const REDACTED = '[REDACTED]';

// ─── Key-name patterns ──────────────────────────────────────────────────────
// Any object key matching one of these has its value replaced. Match is
// case-insensitive and uses exact-string comparison after lower-casing.

const SENSITIVE_KEY_PATTERNS: ReadonlyArray<RegExp> = Object.freeze([
  /^access_token$/i,
  /^accesstoken$/i,
  /^refresh_token$/i,
  /^refreshtoken$/i,
  /^client_secret$/i,
  /^clientsecret$/i,
  /^api_key$/i,
  /^apikey$/i,
  /^private_key$/i,
  /^privatekey$/i,
  /^private_key_id$/i,
  /^privatekeyid$/i,
  /^authorization$/i,       // HTTP Authorization header value
  /^password$/i,
  /^secret$/i,
  /^token$/i,
  /^credential$/i,
  /^credentials$/i,
]);

function isSensitiveKey(key: string): boolean {
  for (const pattern of SENSITIVE_KEY_PATTERNS) {
    if (pattern.test(key)) return true;
  }
  return false;
}

// ─── Value-pattern replacements ──────────────────────────────────────────────
// Applied to string values (via `redactString`) when the key is NOT already
// caught by the key-name list above. Each tuple is [pattern, label].

interface ValuePattern {
  re: RegExp;
  label: string;
}

const VALUE_PATTERNS: ReadonlyArray<ValuePattern> = Object.freeze([
  // OAuth / HTTP Bearer tokens
  {
    re: /Bearer\s+[A-Za-z0-9._-]{10,}/g,
    label: 'Bearer [REDACTED]',
  },
  // OpenAI / Anthropic-style API keys
  {
    re: /sk-[A-Za-z0-9]{10,}/g,
    label: REDACTED,
  },
  // AWS access key IDs
  {
    re: /AKIA[0-9A-Z]{16}/g,
    label: REDACTED,
  },
  // GCP service-account private key block
  {
    re: /-----BEGIN [A-Z ]+KEY-----[\s\S]*?-----END [A-Z ]+KEY-----/g,
    label: REDACTED,
  },
]);

/**
 * Apply regex replacements to a raw string. Used for error messages and
 * other non-object string data.
 */
export function redactString(str: string): string {
  let out = str;
  for (const { re, label } of VALUE_PATTERNS) {
    // Reset lastIndex for global regexes after each string.
    re.lastIndex = 0;
    out = out.replace(re, label);
  }
  return out;
}

/**
 * Deep-clone-and-redact an arbitrary value. Returns a new value with:
 *   - Sensitive key names' values replaced with `[REDACTED]`
 *   - String values that match value patterns replaced via `redactString`
 *
 * Handles null / undefined / primitives / Date / Array / plain objects.
 * Does NOT handle: Map, Set, Buffer, custom class instances beyond Date
 * (they serialise as `{}` in JSON anyway). Does NOT modify the original.
 */
export function redactSecrets(obj: unknown): unknown {
  return walkAndRedact(obj, new WeakSet());
}

function walkAndRedact(value: unknown, seen: WeakSet<object>): unknown {
  // Primitives and null — apply string redaction where applicable.
  if (value === null || value === undefined) return value;
  if (typeof value === 'boolean' || typeof value === 'number') return value;
  if (typeof value === 'string') return redactString(value);

  // Date — safe to return a new Date copy.
  if (value instanceof Date) return new Date(value.getTime());

  // Guard against circular references. In production log objects there
  // shouldn't be cycles, but a misconfigured logger or test might cause one.
  if (typeof value === 'object') {
    if (seen.has(value as object)) return '[Circular]';
    seen.add(value as object);
  }

  // Array — recurse into each element.
  if (Array.isArray(value)) {
    const out: unknown[] = new Array(value.length);
    for (let i = 0; i < value.length; i++) {
      out[i] = walkAndRedact(value[i], seen);
    }
    return out;
  }

  // Plain object — clone with key redaction.
  if (typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src)) {
      if (isSensitiveKey(key)) {
        out[key] = REDACTED;
      } else {
        out[key] = walkAndRedact(src[key], seen);
      }
    }
    return out;
  }

  // Anything else (function, symbol, bigint) — omit.
  return undefined;
}
