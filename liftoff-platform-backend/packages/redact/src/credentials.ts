// Credential redaction for text on its way OUT of a service (E4).
//
// Shared because more than one service does this. It lived in platform-backend
// only, and workforce-service — which generates thread titles from raw user and
// assistant text exactly as platform-backend does — had no redaction at all, so
// a credential pasted into a first message could be baked into a title shown in
// every thread list. Copying the file would have been the fourth forked copy in
// this system to drift from its original; this is the one implementation.
//
// Rolling thread summaries, generated titles, and the absorption classifier all
// take raw conversation or file content and hand it to a model, then store what
// comes back. People paste API keys into chat and into the files they import,
// so without this every one of those paths could bake a live credential into a
// stored summary — a durable copy nobody knows exists.
//
// Ported from the tenant runtime's workspace/secret-scrubber.ts pattern set,
// which is the calibrated one. Two deliberate constraints carried across:
//
//  * Every pattern is BOUNDED (no unbounded `+`/`*`). Unbounded quantifiers on
//    attacker-influenced text are a ReDoS vector.
//  * Connection strings keep their scheme, user, and host and lose only the
//    password, so a redacted summary still reads as "it connected to the
//    reporting database" rather than losing the fact entirely.
//
// This is redaction for egress, NOT a security boundary against a determined
// exfiltrator — a model asked to spell a key out one character at a time would
// defeat any regex. It exists to stop the accidental, routine case.

const REDACTED = '[REDACTED]';

interface NamedPattern {
  name: string;
  re: RegExp;
}

// Bounded PEM block — an unbounded body would be catastrophic on malformed input.
const BOUNDED_PEM =
  /-----BEGIN[A-Z ]{0,32}PRIVATE KEY-----[\s\S]{0,16384}?-----END[A-Z ]{0,32}PRIVATE KEY-----/g;

const SECRET_PATTERNS: NamedPattern[] = [
  { name: 'pem-private-key', re: BOUNDED_PEM },
  // Anthropic
  { name: 'anthropic-api-key', re: /sk-ant-(?:api0[0-9]-)?[A-Za-z0-9_-]{32,128}/g },
  // GitHub
  { name: 'github-classic-pat', re: /ghp_[A-Za-z0-9]{36}/g },
  { name: 'github-fine-grained-pat', re: /github_pat_[A-Za-z0-9_]{22}_[A-Za-z0-9]{59}/g },
  { name: 'github-app-token', re: /ghs_[A-Za-z0-9]{36}/g },
  { name: 'github-user-token', re: /gho_[A-Za-z0-9]{36}/g },
  // Google
  { name: 'google-api-key', re: /AIza[0-9A-Za-z_-]{35}/g },
  { name: 'google-oauth-refresh', re: /1\/\/0[A-Za-z0-9_-]{30,200}/g },
  // OpenAI
  { name: 'openai-legacy-key', re: /sk-[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20}/g },
  { name: 'openai-project-key', re: /sk-proj-[A-Za-z0-9_-]{40,200}/g },
  // Cloud providers
  { name: 'aws-access-key-id', re: /AKIA[0-9A-Z]{16}/g },
  {
    name: 'aws-secret-contextual',
    re: /(?:aws_secret_access_key|AWS_SECRET_ACCESS_KEY|SecretAccessKey)\s*[:=]\s*["']?([A-Za-z0-9/+=]{40})["']?/g,
  },
  { name: 'azure-sas', re: /sv=\d{4}-\d{2}-\d{2}[^&"\s]{0,200}sig=[A-Za-z0-9%\-/+=]{40,200}/g },
  { name: 'gcp-service-account-key', re: /"private_key_id":\s*"[a-f0-9]{40}"/g },
  // SaaS
  { name: 'stripe-live-key', re: /sk_live_[A-Za-z0-9]{24,99}/g },
  { name: 'stripe-restricted-key', re: /rk_live_[A-Za-z0-9]{24,99}/g },
  { name: 'slack-bot-token', re: /xoxb-\d+-\d+-[A-Za-z0-9]{24,48}/g },
  { name: 'slack-user-token', re: /xoxp-\d+-\d+-\d+-[A-Za-z0-9]{24,48}/g },
  { name: 'notion-api-key', re: /(?:secret|ntn)_[A-Za-z0-9]{43}/g },
  { name: 'linear-api-key', re: /lin_api_[A-Za-z0-9]{40,60}/g },
  { name: 'huggingface-token', re: /hf_[A-Za-z]{34}/g },
  { name: 'gitlab-pat', re: /glpat-[A-Za-z0-9_-]{20}/g },
  { name: 'npm-token', re: /npm_[A-Za-z0-9]{36}/g },
  { name: 'jwt', re: /eyJ[A-Za-z0-9_-]{10,200}\.eyJ[A-Za-z0-9_-]{10,2000}\.[A-Za-z0-9_-]{10,2000}/g },
];

/** Authorization headers pasted from a curl command or a doc. */
const BEARER_RE = /\b(Authorization\s*:\s*)(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,4096}/gi;

/** Connection strings: keep scheme/user/host, redact only the password. */
const CONN_STRING_RE =
  /\b(postgres|postgresql|mysql|mongodb|mongodb\+srv|redis|rediss|amqp|amqps|kafka|ftp):\/\/([^:@\s]{1,200}):([^@\s]{1,200})@/gi;

/** Credentials embedded in an http(s) URL. */
const URL_CREDENTIALS_RE = /\b(https?):\/\/([^:@\s/]{1,200}):([^@\s/]{1,200})@/gi;

/** `api_key = "..."`, `password: '...'`, `SECRET=...` and friends. */
const ASSIGNED_SECRET_RE =
  /\b((?:api[_-]?key|apikey|secret|password|passwd|pwd|access[_-]?token|refresh[_-]?token|client[_-]?secret)\s*[:=]\s*)["']?([A-Za-z0-9._~+/=-]{12,512})["']?/gi;

/**
 * Redact credential-shaped substrings. Returns the text unchanged when it holds
 * nothing that matches — this runs on every summary, so the common path must be
 * cheap and lossless.
 */
export function redactSensitiveText(text: string): string {
  if (!text) return text;
  let out = text;

  for (const { re } of SECRET_PATTERNS) {
    re.lastIndex = 0;
    out = out.replace(re, REDACTED);
  }

  BEARER_RE.lastIndex = 0;
  out = out.replace(BEARER_RE, (_m, prefix: string, scheme: string) => `${prefix}${scheme} ${REDACTED}`);

  CONN_STRING_RE.lastIndex = 0;
  out = out.replace(CONN_STRING_RE, (_m, scheme: string, user: string) => `${scheme}://${user}:${REDACTED}@`);

  URL_CREDENTIALS_RE.lastIndex = 0;
  out = out.replace(URL_CREDENTIALS_RE, (_m, scheme: string, user: string) => `${scheme}://${user}:${REDACTED}@`);

  ASSIGNED_SECRET_RE.lastIndex = 0;
  out = out.replace(ASSIGNED_SECRET_RE, (_m, prefix: string) => `${prefix}${REDACTED}`);

  return out;
}

/** Convenience for message arrays (summarization input). */
export function redactMessagesForEgress<T extends { content: string }>(messages: T[]): T[] {
  return messages.map((m) => ({ ...m, content: redactSensitiveText(m.content) }));
}
