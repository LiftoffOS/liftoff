/**
 * @liftoffos/proto-gen/redaction
 *
 * Canonical PII redaction pattern set shared by:
 *   - harvest pre-LLM redaction (liftoff-harvest-service)
 *   - platform-backend export anonymization (liftoff-platform-backend)
 *   - governance-engine audit sanitization (liftoff-governance-engine)
 *
 * Best-effort, pattern-based defense-in-depth. NOT an anonymization or
 * de-identification boundary — names, addresses, unformatted custom IDs,
 * free-text health/financial content, and any PII that doesn't lexically
 * match a pattern here will pass through.
 *
 * Bump REDACTION_VERSION when the pattern set changes (semver):
 *   PATCH — narrowing/widening an existing pattern.
 *   MINOR — new pattern added.
 *   MAJOR — pattern removed or replacement token renamed.
 */

export const REDACTION_VERSION = '1.0.0';

// ─── Pattern definitions (sequencing matters; see redactInternal) ───

const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._\-+/=]+/g;
const AWS_KEY_RE = /\bAKIA[0-9A-Z]{16}\b/g;
const NINE_DIGIT_RE = /(?<!\d)\d{9}(?!\d)/g;
const SSN_FORMATTED_RE = /\b\d{3}-\d{2}-\d{4}\b/g;
const CC_CANDIDATE_RE = /\b(?:\d[ -]?){12,18}\d\b/g;
const IBAN_RE = /\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/g;
const EMAIL_RE = /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g;
// Phone numbers: require at least one separator (space/dash/dot/paren)
// between digit groups so that a bare digit run (e.g. a failed-Luhn CC
// candidate, an order ID) does not match. The plan's original PHONE_RE
// permitted optional separators everywhere, which caused it to consume
// 15 of the 16 digits in a bare credit-card-shaped numeric string.
const PHONE_RE = /(?:\+\d{1,3}[\s.-]+)?(?:\(\d{2,4}\)\s*|\d{2,4}[\s.-]+)\d{3,4}[\s.-]+\d{3,4}/g;

// ─── Checksum helpers ───

function luhnValid(digits: string): boolean {
  if (digits.length < 13 || digits.length > 19) return false;
  let sum = 0;
  let alt = false;
  for (let i = digits.length - 1; i >= 0; i--) {
    let n = parseInt(digits[i], 10);
    if (Number.isNaN(n)) return false;
    if (alt) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
    alt = !alt;
  }
  return sum % 10 === 0;
}

function abaValid(d: string): boolean {
  if (d.length !== 9) return false;
  const first = parseInt(d[0], 10);
  if (first > 1) return false; // US routing numbers start with 0 or 1
  const n = d.split('').map(c => parseInt(c, 10));
  if (n.some(Number.isNaN)) return false;
  const checksum =
    3 * (n[0] + n[3] + n[6]) +
    7 * (n[1] + n[4] + n[7]) +
        (n[2] + n[5] + n[8]);
  return checksum % 10 === 0;
}

// ─── Counter type ───

export type RedactionCounters = Record<string, number>;

export interface RedactionResult {
  redacted: string;
  counters: RedactionCounters;
}

// ─── Internal scrubber ───

function redactInternal(text: string): RedactionResult {
  const counters: RedactionCounters = {};
  const bump = (k: string) => { counters[k] = (counters[k] ?? 0) + 1; };

  let out = text;

  // Order matters: structured / longer patterns first so they consume their
  // own characters before generic patterns (phone, 9-digit) can claim them.
  out = out.replace(JWT_RE, () => { bump('jwt'); return '[REDACTED_JWT]'; });
  out = out.replace(BEARER_RE, () => { bump('bearer'); return 'Bearer [REDACTED_TOKEN]'; });
  out = out.replace(AWS_KEY_RE, () => { bump('aws_key'); return '[REDACTED_AWS_KEY]'; });
  out = out.replace(SSN_FORMATTED_RE, () => { bump('ssn'); return '[REDACTED_SSN]'; });

  // 9-digit run: ABA-checksum first, else SSN.
  out = out.replace(NINE_DIGIT_RE, (m) => {
    if (abaValid(m)) { bump('aba'); return '[REDACTED_ROUTING]'; }
    bump('ssn');
    return '[REDACTED_SSN]';
  });

  // Credit card: Luhn-validated.
  out = out.replace(CC_CANDIDATE_RE, (m) => {
    const digits = m.replace(/[\s-]/g, '');
    if (luhnValid(digits)) { bump('cc'); return '[REDACTED_CC]'; }
    return m;
  });

  out = out.replace(IBAN_RE, () => { bump('iban'); return '[REDACTED_IBAN]'; });
  out = out.replace(EMAIL_RE, () => { bump('email'); return '[REDACTED_EMAIL]'; });
  out = out.replace(PHONE_RE, () => { bump('phone'); return '[REDACTED_PHONE]'; });

  return { redacted: out, counters };
}

// ─── Public API ───

/** Scrub a single string. Returns the redacted string. */
export function redactPii(text: string): string {
  return redactInternal(text).redacted;
}

/** Scrub a string; return per-pattern hit counts alongside. */
export function redactPiiWithCounters(text: string): RedactionResult {
  return redactInternal(text);
}

/**
 * Recursive scrub of any JSON-shaped value.
 *   - strings → redactPii
 *   - arrays → map(redactPiiDeep)
 *   - objects → walk entries, recurse
 *   - null / undefined / numbers / booleans / dates → unchanged
 *
 * Returns a new value; never mutates the input.
 */
export function redactPiiDeep<T>(value: T): T {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactPii(value) as unknown as T;
  if (typeof value !== 'object') return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) return value.map(redactPiiDeep) as unknown as T;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = redactPiiDeep(v);
  }
  return out as T;
}
