// Content sanitizer for auto-reflection memories.
//
// Defense-in-depth: the PRIMARY defense against prompt injection is structural
// containment at injection time (<memory-context> XML with "data not instructions"
// preamble). This sanitizer is a secondary layer that strips obvious patterns
// before persistence and detects PII for classification override.
//
// Not applied to HITL corrections or explicit memory_save calls (high-trust sources).

import { logger } from '../infrastructure/logging';
import { redactCredentials } from './redactor';

const MAX_AUTO_REFLECTION_LENGTH = 2000;

// Prompt injection patterns (regex blocklist — known to be bypassable by
// encoding tricks, but raises the bar for opportunistic attacks)
const INJECTION_PATTERNS: RegExp[] = [
  /ignore\s+(all\s+)?(previous\s+|above\s+)?(instructions|prompts)/i,
  /you\s+are\s+now/i,
  /act\s+as/i,
  /pretend\s+to\s+be/i,
  /from\s+now\s+on/i,
  /reveal\s+(your\s+|the\s+)?(system|prompt|instructions)/i,
  /show\s+(your\s+|the\s+)?(system|prompt|instructions)/i,
  /print\s+(your\s+|the\s+)?(system|prompt|instructions)/i,
  /output\s+(your\s+|the\s+)?(system|prompt|instructions)/i,
  /\bsystem\s*:\s*/i,
  /\bassistant\s*:\s*/i,
  /\bhuman\s*:\s*/i,
];

// PII detection patterns (common formats — not comprehensive but catches
// the most frequent leakage from connector data)
const PII_PATTERNS: { name: string; pattern: RegExp }[] = [
  { name: 'email', pattern: /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g },
  { name: 'phone', pattern: /(\+?1[-.\s]?)?\(?\d{3}\)?[-.\s]?\d{3}[-.\s]?\d{4}/g },
  { name: 'ssn', pattern: /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g },
  { name: 'credit_card', pattern: /\b(?:\d{4}[-.\s]?){3}\d{4}\b/g },
];

export interface SanitizationResult {
  sanitized: string;
  piiDetected: boolean;
  piiTypes: string[];
  strippedPatterns: string[];
  truncated: boolean;
}

export function sanitizeMemoryContent(content: string): SanitizationResult {
  const strippedPatterns: string[] = [];
  let sanitized = content;

  // Strip injection patterns
  for (const pattern of INJECTION_PATTERNS) {
    const match = sanitized.match(pattern);
    if (match) {
      strippedPatterns.push(match[0]);
      sanitized = sanitized.replace(pattern, '[STRIPPED]');
    }
  }

  // Detect PII (don't strip — classify for exclusion from LLM calls)
  const piiTypes: string[] = [];
  for (const { name, pattern } of PII_PATTERNS) {
    // Reset lastIndex for global patterns
    pattern.lastIndex = 0;
    if (pattern.test(sanitized)) {
      piiTypes.push(name);
    }
  }

  // Truncate to max length
  const truncated = sanitized.length > MAX_AUTO_REFLECTION_LENGTH;
  if (truncated) {
    sanitized = sanitized.substring(0, MAX_AUTO_REFLECTION_LENGTH);
  }

  if (strippedPatterns.length > 0 || piiTypes.length > 0) {
    logger.info({
      strippedCount: strippedPatterns.length,
      piiTypes,
      truncated,
    }, 'content-sanitizer: patterns detected in auto-reflection');
  }

  return {
    sanitized,
    piiDetected: piiTypes.length > 0,
    piiTypes,
    strippedPatterns,
    truncated,
  };
}

/**
 * REDACT (strip in place) credentials + PII from free-text content.
 *
 * Distinct from sanitizeMemoryContent above, which is the auto-reflection-memory
 * path: that one only DETECTS pii (classifies for LLM exclusion, leaves it in
 * the stored text) and additionally strips prompt-injection patterns + truncates
 * to MAX_AUTO_REFLECTION_LENGTH. This one actually removes secrets + PII and
 * alters nothing else — for callers that durably persist raw run content (the
 * trajectory sink) and must not retain it unredacted.
 *
 * Reuses the same canonical PII_PATTERNS as the detector, plus the credential
 * redactor (memory/redactor: API keys, tokens, JWTs, private keys, high-entropy).
 */
export function redactSensitiveContent(content: string): string {
  if (!content) return content;
  let out = redactCredentials(content).redacted;
  for (const { name, pattern } of PII_PATTERNS) {
    pattern.lastIndex = 0;
    out = out.replace(pattern, `[REDACTED:${name}]`);
  }
  return out;
}
