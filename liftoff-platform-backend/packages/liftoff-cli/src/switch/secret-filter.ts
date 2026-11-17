// Liftoff Switch — local secret filtering.
//
// Filtering happens BEFORE upload, on the user's machine. The bundle carries
// credential REQUIREMENTS ("Slack connection required"), never credential
// values — this holds even when a source stores a static API key that could
// technically be read and replayed. Composio credentials are especially
// non-portable: they belong to another Composio project and connected-account
// identity, so they could not work here even if we carried them.
//
// Two layers, deliberately redundant:
//   1. Structural — whole files and whole config keys that are credential
//      material by definition are never read into the bundle at all.
//   2. Textual — a scrub over every string that does reach the bundle, so a
//      secret pasted into an instruction file is caught even though the file
//      itself is importable.
//
// The security suite asserts that known secret formats never appear in an
// uploaded manifest or in logs.

/** Files that are credential material by definition. Matched on basename. */
const CREDENTIAL_FILENAMES = new Set([
  '.env',
  '.env.local',
  '.env.production',
  '.env.development',
  'credentials.json',
  'credentials',
  'auth.json',
  'auth.db',
  'token.json',
  'tokens.json',
  'oauth.json',
  'session.json',
  'keyring.json',
  'secrets.json',
  'secrets.yaml',
  'secrets.yml',
  '.netrc',
  '.npmrc',
  'id_rsa',
  'id_ed25519',
]);

/** Directories whose entire contents are excluded: auth material, live process
 *  state, raw transcripts, and executable plugin code. */
const EXCLUDED_DIR_SEGMENTS = [
  'auth',
  'credentials',
  'secrets',
  'keyring',
  'sessions',
  'transcripts',
  'history',
  'runtime',
  'run',
  'pids',
  'node_modules',
  '.git',
  'plugins',
  'extensions',
  'venv',
  '__pycache__',
];

/** Config keys whose VALUES are never carried, whatever the surrounding file.
 *  Matched case-insensitively against the full key path. */
const CREDENTIAL_KEY_PATTERNS: RegExp[] = [
  /(^|[._-])api[._-]?key$/i,
  /(^|[._-])apikey$/i,
  /(^|[._-])secret([._-]?key)?$/i,
  /(^|[._-])client[._-]?secret$/i,
  /(^|[._-])access[._-]?token$/i,
  /(^|[._-])refresh[._-]?token$/i,
  /(^|[._-])bearer([._-]?token)?$/i,
  /(^|[._-])password$/i,
  /(^|[._-])passwd$/i,
  /(^|[._-])private[._-]?key$/i,
  /(^|[._-])cookie$/i,
  /(^|[._-])session[._-]?token$/i,
  /(^|[._-])auth[._-]?token$/i,
  /(^|[._-])credential(s)?$/i,
  /(^|[._-])token$/i,
  /(^|[._-])signing[._-]?key$/i,
  /(^|[._-])webhook[._-]?secret$/i,
];

/** Known secret FORMATS. These catch a credential pasted into an instruction
 *  file, where no key name protects it. Ordered most specific first. */
const SECRET_VALUE_PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: 'anthropic_key', re: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { name: 'openai_key', re: /\bsk-(?!ant-)[A-Za-z0-9]{20,}/g },
  { name: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { name: 'github_pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { name: 'slack_token', re: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { name: 'slack_webhook', re: /https:\/\/hooks\.slack\.com\/services\/[A-Za-z0-9/]+/g },
  { name: 'google_key', re: /\bAIza[A-Za-z0-9_-]{30,}/g },
  { name: 'aws_access_key', re: /\b(?:AKIA|ASIA)[A-Z0-9]{16}\b/g },
  { name: 'stripe_key', re: /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}/g },
  { name: 'private_key_block', re: /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g },
  { name: 'jwt', re: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  { name: 'bearer_header', re: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  { name: 'basic_header', re: /\bBasic\s+[A-Za-z0-9+/]{20,}=*/g },
  { name: 'postgres_url', re: /\b(?:postgres|postgresql|mysql|mongodb(?:\+srv)?):\/\/[^\s:@/]+:[^\s@]+@[^\s]+/g },
  { name: 'generic_assignment', re: /\b(?:api[_-]?key|secret|token|password|passwd)\s*[:=]\s*["']?[A-Za-z0-9._~+/-]{16,}=*["']?/gi },
];

export const REDACTION_PLACEHOLDER = '[REDACTED]';

export interface RedactionSummary {
  /** Number of redactions by detected format name. Counts only; no values. */
  countsByType: Record<string, number>;
  total: number;
}

export function emptyRedactionSummary(): RedactionSummary {
  return { countsByType: {}, total: 0 };
}

/** True when a file is credential material by name and must never be read. */
export function isCredentialFile(filePath: string): boolean {
  const base = basename(filePath).toLowerCase();
  if (CREDENTIAL_FILENAMES.has(base)) return true;
  if (base.startsWith('.env')) return true;
  if (base.endsWith('.pem') || base.endsWith('.key') || base.endsWith('.p12') || base.endsWith('.pfx')) return true;
  return false;
}

/** True when a path lies inside a directory whose contents are excluded
 *  wholesale (auth material, live state, transcripts, executable plugins). */
export function isExcludedPath(filePath: string): boolean {
  const segments = filePath.split(/[\\/]+/).map((s) => s.toLowerCase());
  return segments.some((seg) => EXCLUDED_DIR_SEGMENTS.includes(seg));
}

/** True when a configuration key's value is credential material. */
export function isCredentialKey(keyPath: string): boolean {
  return CREDENTIAL_KEY_PATTERNS.some((re) => re.test(keyPath));
}

/** Scrub known secret formats out of text destined for the bundle.
 *
 *  Returns the redacted text plus a count-only summary. The summary never
 *  contains a fragment of the secret: a support view can say "3 credentials
 *  were redacted from this file" without re-leaking them. */
export function redactText(text: string, summary?: RedactionSummary): { text: string; summary: RedactionSummary } {
  const acc = summary ?? emptyRedactionSummary();
  let out = text;
  for (const { name, re } of SECRET_VALUE_PATTERNS) {
    out = out.replace(new RegExp(re.source, re.flags), () => {
      acc.countsByType[name] = (acc.countsByType[name] ?? 0) + 1;
      acc.total += 1;
      return REDACTION_PLACEHOLDER;
    });
  }
  return { text: out, summary: acc };
}

/** Recursively redact a parsed configuration object.
 *
 *  Credential-keyed values are replaced wholesale (the key name tells us the
 *  value is a secret regardless of its shape); every other string is scrubbed
 *  for known secret formats. */
export function redactConfigValue(
  value: unknown,
  summary?: RedactionSummary,
  keyPath = '',
): { value: unknown; summary: RedactionSummary } {
  const acc = summary ?? emptyRedactionSummary();

  if (typeof value === 'string') {
    if (keyPath && isCredentialKey(keyPath)) {
      acc.countsByType.credential_key = (acc.countsByType.credential_key ?? 0) + 1;
      acc.total += 1;
      return { value: REDACTION_PLACEHOLDER, summary: acc };
    }
    const { text } = redactText(value, acc);
    return { value: text, summary: acc };
  }

  if (Array.isArray(value)) {
    const out = value.map((v) => redactConfigValue(v, acc, keyPath).value);
    return { value: out, summary: acc };
  }

  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      const childPath = keyPath ? `${keyPath}.${k}` : k;
      if (isCredentialKey(childPath) || isCredentialKey(k)) {
        acc.countsByType.credential_key = (acc.countsByType.credential_key ?? 0) + 1;
        acc.total += 1;
        out[k] = REDACTION_PLACEHOLDER;
        continue;
      }
      out[k] = redactConfigValue(v, acc, childPath).value;
    }
    return { value: out, summary: acc };
  }

  return { value, summary: acc };
}

/** Final gate run over the serialized bundle immediately before upload.
 *
 *  Structural exclusion and per-file redaction should already have removed
 *  every secret; this asserts it. A hit here is a bug in an adapter, and the
 *  upload is refused rather than "cleaned" — silently fixing it would hide the
 *  adapter defect that produced it. */
export function assertNoSecrets(serialized: string): void {
  const found: string[] = [];
  for (const { name, re } of SECRET_VALUE_PATTERNS) {
    const probe = new RegExp(re.source, re.flags.replace('g', ''));
    if (probe.test(serialized)) found.push(name);
  }
  if (found.length > 0) {
    throw new Error(
      `Upload refused: the migration bundle still contains credential-shaped values (${found.join(', ')}). ` +
        'This is an importer defect. Nothing was uploaded and your source installation was not modified.',
    );
  }
}

function basename(p: string): string {
  const parts = p.split(/[\\/]+/);
  return parts[parts.length - 1] ?? p;
}
