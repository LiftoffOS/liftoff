// Aggressive prompt-injection / jailbreak classifier.
//
// Per-source toggleable (default ON). Returns the list of patterns that
// fired so the rejection delivery row can record exactly what tripped it.
// This is defense-in-depth, NOT a complete defense — the executor-side
// approval gate is the actual safety net.

import type { CanonicalEnvelope } from './envelope';

interface Pattern {
  name: string;
  re: RegExp;
}

const PATTERNS: Pattern[] = [
  {
    name: 'ignore_instructions',
    re: /\bignore\s+(?:the\s+|all\s+|any\s+|your\s+|previous\s+|prior\s+|above\s+|preceding\s+)*(?:instructions?|prompts?|rules?|context|directives?|guidelines?)\b/i,
  },
  {
    name: 'disregard_instructions',
    re: /\b(?:disregard|forget)\s+(?:the\s+|your\s+|all\s+|any\s+|previous\s+|prior\s+|above\s+)*(?:instructions?|training|rules?|context)\b/i,
  },
  {
    name: 'persona_override',
    re: /\byou\s+are\s+(?:now|hereafter|from\s+now\s+on)\s+(?:a|an|the)\s+[^.]{1,200}/i,
  },
  {
    name: 'new_instruction_block',
    re: /\bnew\s+(?:instructions?|task|role|persona|system\s+prompt)\s*:/i,
  },
  {
    name: 'pretend',
    re: /\bpretend\s+(?:you\s+are|to\s+be)\b/i,
  },
  {
    name: 'act_as',
    re: /\bact\s+as\s+(?:a|an|the)\b/i,
  },
  {
    name: 'encoded_base64',
    re: /\bbase64\s*:/i,
  },
  {
    name: 'encoded_rot13',
    re: /\brot13\s*:/i,
  },
  {
    name: 'hex_escape_run',
    re: /(?:\\x[0-9a-f]{2}){4,}/i,
  },
];

export interface ContentFilterResult {
  blocked: boolean;
  matched: string[];
}

function* iterStrings(v: unknown): IterableIterator<string> {
  if (v === null || v === undefined) return;
  if (typeof v === 'string') {
    yield v;
    return;
  }
  if (Array.isArray(v)) {
    for (const item of v) yield* iterStrings(item);
    return;
  }
  if (typeof v === 'object') {
    for (const value of Object.values(v as Record<string, unknown>)) {
      yield* iterStrings(value);
    }
  }
}

/**
 * Returns `blocked: true` and the list of matched pattern names when any of
 * the regexes fire against any string field anywhere inside the envelope.
 * Normalises whitespace before matching so e.g. tabs/newlines don't sneak
 * past the `\s+` between tokens.
 */
export function classifyContent(envelope: CanonicalEnvelope): ContentFilterResult {
  const matched = new Set<string>();
  // Run against subject/actor/data only — event_id/event_type/occurred_at
  // are already shape-constrained and shouldn't contain prose.
  const candidates: unknown[] = [envelope.subject, envelope.actor, envelope.data];
  for (const candidate of candidates) {
    for (const raw of iterStrings(candidate)) {
      const normalized = raw.replace(/\s+/g, ' ');
      for (const pattern of PATTERNS) {
        if (pattern.re.test(normalized)) matched.add(pattern.name);
      }
    }
  }
  return { blocked: matched.size > 0, matched: [...matched] };
}
