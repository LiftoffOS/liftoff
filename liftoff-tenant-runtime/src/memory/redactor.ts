// WS-8.1 — in-process credential redactor (Layer 1).
//
// Replaces the previous network-call DLP guard. Always runs synchronously
// in-process; never fails. The agent's redacted content is what gets
// persisted; the response carries a `redactions` field so the model knows
// what was scrubbed.

export interface RedactionMatch {
  path: string; // JSON-pointer-ish path within the input (e.g., "content", "metadata.token")
  kind: RedactionKind;
  span: [number, number];
  original_length: number;
}

export type RedactionKind =
  | 'openai_api_key'
  | 'stripe_secret_key'
  | 'slack_bot_token'
  | 'slack_user_token'
  | 'google_oauth_token'
  | 'aws_access_key'
  | 'github_token'
  | 'gitlab_pat'
  | 'jwt'
  | 'private_key'
  | 'high_entropy_string';

const CREDENTIAL_PATTERNS: Array<{ kind: RedactionKind; regex: RegExp }> = [
  { kind: 'openai_api_key',     regex: /\bsk-[A-Za-z0-9]{20,}\b/g },
  { kind: 'stripe_secret_key',  regex: /\bsk_(?:live|test)_[A-Za-z0-9]{24,}\b/g },
  { kind: 'slack_bot_token',    regex: /\bxoxb-[0-9]+-[0-9]+-[A-Za-z0-9]+\b/g },
  { kind: 'slack_user_token',   regex: /\bxoxp-[0-9]+-[0-9]+-[0-9]+-[A-Za-z0-9]+\b/g },
  { kind: 'google_oauth_token', regex: /\bya29\.[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'aws_access_key',     regex: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'github_token',       regex: /\bgh[pousr]_[A-Za-z0-9]{36,}\b/g },
  { kind: 'gitlab_pat',         regex: /\bglpat-[A-Za-z0-9_-]{20,}\b/g },
  { kind: 'jwt',                regex: /\beyJ[A-Za-z0-9_-]+\.eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g },
  { kind: 'private_key',        regex: /-----BEGIN (?:RSA |DSA |EC |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY-----[\s\S]+?-----END (?:RSA |DSA |EC |OPENSSH |ENCRYPTED |PGP )?PRIVATE KEY-----/g },
];

// Tunable threshold; anchored at 4.0 bits/char (high mixed-symbol entropy).
const ENTROPY_BITS_PER_CHAR_THRESHOLD = 4.0;
const ENTROPY_MIN_LENGTH = 32;

/** A Google Drive file id: `1` followed by 43 of `[A-Za-z0-9_-]`.
 *
 *  Matched by its own signature. The alternative — lowering
 *  ENTROPY_BITS_PER_CHAR_THRESHOLD until a document id survives — would exempt
 *  every secret of similar shape at the same time, which is the opposite of
 *  what is wanted.
 *
 *  Legacy `0A`/`0B`-prefixed ids are deliberately NOT here. They have not been
 *  observed reaching a memory, and a pattern added on speculation widens a
 *  credential exemption for no demonstrated gain. Add one when one shows up. */
const GOOGLE_DRIVE_FILE_ID = /^1[A-Za-z0-9_-]{43}$/;

/** Is this token an opaque handle to a document, rather than a secret?
 *
 *  THE DISTINCTION IS NOT COSMETIC. An API key IS the access: holding it is
 *  being authorised. A document id grants nothing — reaching the document needs
 *  the connector's OAuth grant, and a reader without that grant gets a 404 from
 *  the id alone. The entropy fallback cannot see that difference: a Drive id is
 *  44 characters, mixed case, with digits, entropy ~4.9, and so are plenty of
 *  real keys.
 *
 *  Residual risk, stated rather than waved away: a genuine secret that is
 *  exactly 44 characters, starts with `1`, and uses this alphabet would pass.
 *  Two things still cover it — every credential format with a recognisable
 *  prefix is caught by PASS 1 before this runs, and Layer 2's deep scan reads
 *  what Layer 1 lets through. */
export function isPlatformResourceId(token: string): boolean {
  return GOOGLE_DRIVE_FILE_ID.test(token);
}

export interface RedactOptions {
  /** Keep platform resource ids (`isPlatformResourceId`) instead of redacting
   *  them.
   *
   *  OFF by default, and every existing caller keeps today's behaviour. On only
   *  where an AGENT is explicitly recording its own work and the ids are the
   *  substance of what it is recording — `memory_save` and `record_research_finding`,
   *  which this codebase already classifies as high-trust sources (see
   *  content-sanitizer.ts, which deliberately does not run on them).
   *
   *  Without it, an agent recording where its documents live — watch list,
   *  snapshot, battle cards, digest — has every id replaced with
   *  `[REDACTED:high_entropy_string]`. The row stores fine and reads as healthy,
   *  so nothing surfaces it: the memory still says "Watch list id ..." with the
   *  id gone.
   *
   *  NOT on for the reflection and consolidation paths, which run over
   *  model-generated summaries rather than an agent's explicit write and are the
   *  lower-trust tier the sanitizer exists for. The consequence is worth naming:
   *  a consolidation pass over a memory holding ids will still redact them. That
   *  is a known boundary, not an oversight. */
  keepResourceIds?: boolean;
}

function shannonEntropy(s: string): number {
  const freq = new Map<string, number>();
  for (const c of s) freq.set(c, (freq.get(c) ?? 0) + 1);
  let h = 0;
  for (const n of freq.values()) {
    const p = n / s.length;
    h -= p * Math.log2(p);
  }
  return h;
}

export function redactCredentials(
  input: string,
  opts: RedactOptions = {},
): { redacted: string; matches: RedactionMatch[] } {
  const matches: RedactionMatch[] = [];
  let out = input;

  // Pass 1: regex patterns.
  for (const { kind, regex } of CREDENTIAL_PATTERNS) {
    out = out.replace(regex, (m, offset: number) => {
      matches.push({ path: '', kind, span: [offset, offset + m.length], original_length: m.length });
      return `[REDACTED:${kind}]`;
    });
  }

  // Pass 2: high-entropy fallback. Scan whitespace-delimited tokens.
  // Cheap, deterministic; misses are caught by Layer 2 deep-scan.
  out = out.replace(/[A-Za-z0-9_+/=-]{32,}/g, (m, offset: number) => {
    if (m.length < ENTROPY_MIN_LENGTH) return m;
    // Before the entropy maths, deliberately: the threshold is left exactly
    // where it was, and this exempts one recognised shape rather than lowering
    // the bar for everything that shape resembles.
    if (opts.keepResourceIds && isPlatformResourceId(m)) return m;
    const e = shannonEntropy(m);
    if (e >= ENTROPY_BITS_PER_CHAR_THRESHOLD && /[a-z]/.test(m) && /[A-Z]/.test(m) && /[0-9]/.test(m)) {
      matches.push({ path: '', kind: 'high_entropy_string', span: [offset, offset + m.length], original_length: m.length });
      return `[REDACTED:high_entropy_string]`;
    }
    return m;
  });

  return { redacted: out, matches };
}

// Walk an arbitrary JSON-like value, redacting credentials in every string
// field. Returns the redacted value + the cumulative match list with paths.
export function redactJson(
  value: unknown,
  basePath = '',
  opts: RedactOptions = {},
): { value: unknown; matches: RedactionMatch[] } {
  if (typeof value === 'string') {
    const r = redactCredentials(value, opts);
    return { value: r.redacted, matches: r.matches.map((m) => ({ ...m, path: basePath })) };
  }
  if (Array.isArray(value)) {
    const out: unknown[] = [];
    const matches: RedactionMatch[] = [];
    for (let i = 0; i < value.length; i++) {
      const sub = redactJson(value[i], `${basePath}[${i}]`, opts);
      out.push(sub.value);
      matches.push(...sub.matches);
    }
    return { value: out, matches };
  }
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    const matches: RedactionMatch[] = [];
    for (const [k, v] of Object.entries(value)) {
      const sub = redactJson(v, basePath ? `${basePath}.${k}` : k, opts);
      out[k] = sub.value;
      matches.push(...sub.matches);
    }
    return { value: out, matches };
  }
  return { value, matches: [] };
}
