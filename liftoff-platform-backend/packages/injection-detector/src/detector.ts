// Deterministic, obfuscation-defeating prompt-injection detector.
//
// This is a pure, LLM-free analysis library. It normalizes input to defeat
// common obfuscation (leet-speak, Cyrillic homoglyphs, zero-width/bidi
// characters, fullwidth ASCII, Unicode compatibility confusables), matches a
// scored set of non-backtracking regex rules across three normalized variants,
// adds two obfuscation heuristics, and maps the summed score to a verdict.
//
// It runs BEFORE any model call and can be reused at every untrusted-content
// ingress. It is a best-effort accelerator in front of the LLM guard, never a
// complete gate: an English-only ruleset means non-English injection must still
// be caught by the (multilingual) LLM guard downstream.

import { createHash } from 'node:crypto';

export type InjectionVerdict = 'allow' | 'review' | 'block';

export interface InjectionReason {
  /** Short rule code, safe to publish in audit events (never the raw text). */
  code: string;
  /** Human-readable summary of the rule that fired. */
  message: string;
}

export interface InjectionContext {
  /** Where the input came from (e.g. 'chat', 'trigger', 'tool_result'). */
  source: string;
  requestId?: string;
  userId?: string;
  sessionId?: string;
  tenantId?: string;
  agentId?: string;
}

export interface InjectionDecision {
  verdict: InjectionVerdict;
  score: number;
  reasons: InjectionReason[];
  /** SHA-256 of the (untruncated) input. PII-safe: the text is never returned. */
  hash: string;
  /** Number of characters actually scanned (input length capped at MAX_SCAN_CHARS). */
  scannedChars: number;
}

/**
 * Upper bound on the characters scanned by the detector. Over-cap input is
 * truncated for scanning only (never rejected) so a very large payload cannot
 * turn a linear scan into a latency problem. Injection markers almost always
 * appear near the start of an instruction-bearing blob, so a bounded prefix is
 * sufficient. The full input is still hashed for audit correlation.
 */
export const MAX_SCAN_CHARS = 20_000;

/** Verdict thresholds (calibrated defaults; the host's shadow bake finalizes them). */
export const BLOCK_THRESHOLD = 0.7;
export const REVIEW_THRESHOLD = 0.55;

// ── Normalization maps ────────────────────────────────────────────────────────

/** Leet-speak digit/symbol → letter folding (applied to the mapped variants). */
const LEET_MAP: Record<string, string> = {
  '0': 'o',
  '1': 'i',
  '3': 'e',
  '4': 'a',
  '5': 's',
  '7': 't',
  '8': 'b',
  '6': 'g',
  '@': 'a',
};

/** Most common Cyrillic → Latin homoglyphs (UAX#39 confusables). NFKC does not
 *  fold cross-script confusables, so these are handled explicitly. */
const CYRILLIC_MAP: Record<string, string> = {
  'а': 'a', // а
  'е': 'e', // е
  'о': 'o', // о
  'р': 'p', // р
  'с': 'c', // с
  'у': 'y', // у
  'х': 'x', // х
  'і': 'i', // і
  'ѕ': 's', // ѕ
  'һ': 'h', // һ
  'ԁ': 'd', // ԁ
};

/** Zero-width, bidi, and formatting characters that should be stripped (and
 *  flagged) during normalization. Shared between the `hadZwsp` flag and the
 *  stripping step so the two never drift. */
function isObfuscationChar(ch: string): boolean {
  const c = ch.codePointAt(0)!;
  return (
    c === 0x200b || // zero-width space
    c === 0x200c || // zero-width non-joiner
    c === 0x200d || // zero-width joiner
    c === 0x2060 || // word joiner
    c === 0xfeff || // zero-width no-break space
    c === 0x00ad || // soft hyphen
    c === 0x034f || // combining grapheme joiner
    c === 0x180e || // mongolian vowel separator
    c === 0x200e || // LTR mark
    c === 0x200f || // RTL mark
    (c >= 0x202a && c <= 0x202e) || // bidi embedding/override
    (c >= 0x2066 && c <= 0x2069) // bidi isolate
  );
}

/** A run of base64-looking characters (potential encoded payload). */
const BASE64_RE = /[A-Za-z0-9+/]{24,}={0,2}/;

interface NormalizedPrompt {
  /** Plain lowercase (NFKC-folded), no char mapping. */
  lowered: string;
  /** Char-mapped + whitespace-collapsed. */
  collapsed: string;
  /** Char-mapped + whitespace-stripped (catches spaced-out attacks). */
  compact: string;
  hadZwsp: boolean;
  hasBase64Marker: boolean;
  hasInstructionOverride: boolean;
  hasExfiltrationIntent: boolean;
}

function normalizePrompt(input: string): NormalizedPrompt {
  // NFKC first — folds fullwidth ASCII, mathematical-alphanumeric, and other
  // Unicode compatibility confusables that have canonical decompositions.
  const lowered = input.normalize('NFKC').toLowerCase();
  const hasBase64Marker = BASE64_RE.test(lowered);

  let hadZwsp = false;
  let buffer = '';
  for (const ch of lowered) {
    const leet = LEET_MAP[ch];
    if (leet !== undefined) {
      buffer += leet;
      continue;
    }
    const cyr = CYRILLIC_MAP[ch];
    if (cyr !== undefined) {
      buffer += cyr;
      continue;
    }
    if (isObfuscationChar(ch)) {
      hadZwsp = true;
      continue;
    }
    const code = ch.codePointAt(0)!;
    // Fullwidth ASCII → ASCII (mostly folded by NFKC already; kept for safety).
    if (code >= 0xff01 && code <= 0xff5e) {
      buffer += String.fromCodePoint(code - 0xff00 + 0x20).toLowerCase();
      continue;
    }
    // Keep ASCII alphanumerics and whitespace; map everything else to a space
    // so token boundaries survive but punctuation obfuscation collapses.
    if ((ch >= 'a' && ch <= 'z') || (ch >= '0' && ch <= '9') || /\s/.test(ch)) {
      buffer += ch;
    } else {
      buffer += ' ';
    }
  }

  const collapsed = buffer.trim().replace(/\s+/g, ' ');
  const compact = collapsed.replace(/\s+/g, '');

  const hasInstructionOverride =
    collapsed.includes('ignore previous instructions') ||
    collapsed.includes('ignore all previous instructions') ||
    compact.includes('ignoreallpreviousinstructions') ||
    compact.includes('ignorepreviousinstructions');

  const revealTargetHints = [
    'system',
    'hidden',
    'developer',
    'internal',
    'prompt',
    'instruction',
    'rule',
    'secret',
  ];
  const hasExfiltrationIntent =
    collapsed.includes('system prompt') ||
    collapsed.includes('developer instructions') ||
    collapsed.includes('hidden prompt') ||
    collapsed.includes('internal instructions') ||
    (collapsed.includes('reveal') && revealTargetHints.some((h) => collapsed.includes(h)));

  return {
    lowered,
    collapsed,
    compact,
    hadZwsp,
    hasBase64Marker,
    hasInstructionOverride,
    hasExfiltrationIntent,
  };
}

// ── Detection rules ───────────────────────────────────────────────────────────
//
// Ported from the reference deterministic detector. Every `.*` from the source
// (which ran on a linear-time regex engine) is replaced with a bounded window
// (`.{0,N}`) so these patterns are non-backtracking under JavaScript's regex
// engine — ReDoS-safe even before the MAX_SCAN_CHARS cap. Patterns are matched
// against already-lowercased variants, so no `i` flag is needed.

interface DetectionRule {
  code: string;
  message: string;
  score: number;
  pattern: RegExp;
}

const DETECTION_RULES: DetectionRule[] = [
  {
    code: 'override.ignore_previous',
    message: 'Attempts to override existing safety or system instructions.',
    score: 0.44,
    pattern:
      /(ignore|disregard|forget|bypass)\s+(all\s+)?(previous|prior|above|system)\s+(instructions|rules|constraints|prompts?)/,
  },
  {
    code: 'override.role_hijack',
    message: 'Attempts to redefine assistant role or policy scope.',
    score: 0.3,
    pattern:
      /(you\s+are\s+now|developer\s+mode|jailbreak|unrestricted\s+mode|(you\s+are|pretend\s+you\s+are|act\s+as)\s+dan\b|(no\s+restrictions|unrestricted)\s+.{0,40}\bdan\b|\bdan\b\s+.{0,40}(no\s+restrictions|unrestricted))/,
  },
  {
    code: 'exfiltrate.system_prompt',
    message: 'Attempts to reveal hidden prompts or developer instructions.',
    score: 0.42,
    pattern:
      /(reveal|show|print|dump|leak|display)\s+((the|your)\s+)?(system|developer|hidden)\s+(prompt|instructions|rules|message)/,
  },
  {
    code: 'exfiltrate.secrets',
    message: 'Mentions secret-bearing nouns (potentially benign on its own).',
    score: 0.18,
    pattern: /(api\s*key|secret|token|password|private\s+key|credentials?|session\s+cookie|jwt|bearer)/,
  },
  {
    code: 'exfiltrate.credentials_with_intent',
    message: 'Attempts to extract credentials, secrets, or tokens (verb + target).',
    score: 0.46,
    pattern:
      /(reveal|print|dump|leak|display|share|expose|exfiltrate)\s+(\S+\s+){0,2}(the|your|my|all|stored|active|internal|hidden|configured|saved|env|environment)\s+(\S+\s+){0,3}(api\s*key|secret|token|password|private\s+key|credentials?|session\s+cookie|jwt|bearer)/,
  },
  {
    code: 'tool.abuse',
    message: 'Attempts to force unsafe tool usage or policy bypass.',
    score: 0.3,
    pattern:
      /(call|use|run|execute)\s+(the\s+)?(tool|tools?|function|functions?)\s+.{0,60}(without\s+approval|even\s+if\s+forbidden|no\s+matter\s+what)/,
  },
];

function analyze(input: string): { verdict: InjectionVerdict; score: number; reasons: InjectionReason[] } {
  const normalized = normalizePrompt(input);
  let score = 0;
  const reasons: InjectionReason[] = [];

  if (normalized.hasInstructionOverride) {
    // Above the Review threshold on its own so spacing-obfuscated overrides
    // ("i g n o r e   a l l   p r e v i o u s …") that only trip this heuristic
    // (the regex rule requires whitespace between real tokens) still land at
    // Review level.
    score += 0.56;
    reasons.push({
      code: 'override.obfuscated_instruction',
      message: 'Detected obfuscated instruction-override phrase.',
    });
  }
  if (normalized.hasExfiltrationIntent) {
    score += 0.24;
    reasons.push({
      code: 'exfiltration.intent',
      message: 'Detected exfiltration-focused prompt intent.',
    });
  }

  for (const rule of DETECTION_RULES) {
    if (
      rule.pattern.test(normalized.lowered) ||
      rule.pattern.test(normalized.collapsed) ||
      rule.pattern.test(normalized.compact)
    ) {
      score += rule.score;
      reasons.push({ code: rule.code, message: rule.message });
    }
  }

  // Base64 marker is informational only (never scored on its own) — long
  // base64 strings appear in benign content (data URIs, tokens the user is
  // legitimately granting), so it must not push a verdict by itself. It is
  // surfaced as a reason only when the input already tripped an override or
  // exfiltration signal, matching the FP-conscious reference design.
  if (normalized.hasBase64Marker && reasons.length > 0) {
    reasons.push({
      code: 'obfuscation.base64_marker',
      message: 'Input also contains a base64-looking blob.',
    });
  }

  score = Math.min(score, 1);
  const verdict: InjectionVerdict =
    score >= BLOCK_THRESHOLD ? 'block' : score >= REVIEW_THRESHOLD ? 'review' : 'allow';

  return { verdict, score, reasons };
}

// ── Structured-payload leaf extraction ────────────────────────────────────────

const MAX_LEAF_DEPTH = 12;

function collectStringLeaves(value: unknown, out: string[], depth: number): void {
  if (depth > MAX_LEAF_DEPTH) return;
  if (typeof value === 'string') {
    out.push(value);
  } else if (Array.isArray(value)) {
    for (const v of value) collectStringLeaves(v, out, depth + 1);
  } else if (value && typeof value === 'object') {
    for (const v of Object.values(value)) collectStringLeaves(v, out, depth + 1);
  }
}

/**
 * Extract the concatenated STRING LEAF VALUES of a structured payload (JSON
 * webhook body, structured tool result) for scanning. Scanning the serialized
 * blob would dilute rule signal with braces/keys and risk false matches on
 * legitimate structure; scanning only the string leaves keeps the natural-
 * language surface the rules target.
 */
export function extractScannableText(value: unknown): string {
  if (typeof value === 'string') return value;
  const out: string[] = [];
  collectStringLeaves(value, out, 0);
  return out.join('\n');
}

// ── Public API ────────────────────────────────────────────────────────────────

/** SHA-256 hex of the input. PII-safe: used for audit correlation, never returns text. */
export function promptHash(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

/**
 * Screen a prompt/content string for injection. Returns a verdict, score, the
 * fired reason codes, and a PII-safe hash. The scan is bounded to
 * MAX_SCAN_CHARS; the hash covers the full input.
 *
 * The `ctx` is not used for the verdict — it is accepted so callers can thread
 * request/tenant/agent identifiers into their own audit log alongside the
 * returned decision.
 */
export function enforcePromptInput(input: string, ctx?: InjectionContext): InjectionDecision {
  void ctx;
  const scanInput = input.length > MAX_SCAN_CHARS ? input.slice(0, MAX_SCAN_CHARS) : input;
  const { verdict, score, reasons } = analyze(scanInput);
  return {
    verdict,
    score,
    reasons,
    hash: promptHash(input),
    scannedChars: scanInput.length,
  };
}

/**
 * Screen a structured payload (JSON object / tool result) by extracting its
 * string leaf values first. Convenience wrapper over enforcePromptInput.
 */
export function enforceStructuredInput(value: unknown, ctx?: InjectionContext): InjectionDecision {
  return enforcePromptInput(extractScannableText(value), ctx);
}
