/**
 * Distill-prompt invariant logic — pure functions over plain types.
 *
 * Kept free of any imports from src/internal-agents/ or src/connectors/ so
 * unit tests can exercise the classifiers without dragging in the LLM client,
 * tenant-runtime client, or proto-gen modules.
 *
 * The harness in verify-distill-invariants.ts imports INVARIANTS from here and
 * is the only place that calls distillInternalAgent / getCatalog.
 */

export interface InputDoc {
  filePath: string;            // identifier for logging; NOT used in invariant logic
  role: string;
  responsibilities: string;
  additionalContext: string;
  // requiredConnectors / optionalConnectors used only to compute which connector
  // catalogs are in scope when checking I1's catalog-side trigger
  connectorRefs: Array<{ capability?: string; connectorType?: string }>;
}

export interface DistilledOutput {
  triggerConfig?: {
    type?: string;
    cronExpr?: string;
    eventTopic?: string;
    companionCrons?: Array<{ label: string; cronExpr: string; objective?: string }>;
    reactiveSubscriptions?: Array<{ label: string; source: { kind: string }; objective: string }>;
  };
  skills?: Array<{ name: string; description: string; instruction: string }>;
  userInstructions?: string;
  instructionsMd?: string;
}

export interface InvariantTrigger {
  triggers: boolean;
  /** Human-readable reason classification fired (or didn't), for logs/debugging. */
  reason: string;
}

export interface InvariantCheck {
  ok: boolean;
  /** Output-side details when failing. */
  reason: string;
}

export interface Invariant {
  id: 'I1' | 'I2' | 'I3' | 'I4' | 'I5';
  description: string;
  triggersOnInput: (
    doc: InputDoc,
    catalogSchemasByType: Record<string, Record<string, unknown>>,
  ) => InvariantTrigger;
  satisfiedByOutput: (distilled: DistilledOutput) => InvariantCheck;
}

// ─── Regex patterns reused across invariants (text-shape detection) ────────

export const RESP_HAS_BUSINESS_DAYS = /\bbusiness days?\b/i;
// Sequential-deadline language: "touch N", "day N", "follow up after ... then ..." patterns.
// Note: combining individual regexes via `.source` strips their flags — we must
// re-apply `i` here or the combined regex is case-sensitive and misses "Day 1,
// Day 7, Day 14" text the per-part regex authors clearly intended to match.
export const RESP_HAS_SEQUENTIAL_DEADLINES = new RegExp(
  [
    /\btouch\s*\d/i.source,
    /\bday\s*\d+\s*[,/]\s*day\s*\d/i.source,                           // "day 1, day 7, day 14"
    /\bfollow[\s-]*up.*\bthen\b.*\b(?:notify|escalate|follow)/i.source, // "follow up after X, then escalate after Y"
    /\bn?\s*=\s*\{[^}]*\d+[^}]*,[^}]*\d+[^}]*\}/i.source,              // "for N ∈ {1,7,14}"
  ].join('|'),
  'is',
);
// Event-keyed-deadline language: "if no [X] within N hours/days", "N hours after",
// "M business days after [X]", where X is a transient-event noun like reply, message, etc.
export const RESP_HAS_EVENT_KEYED_DEADLINE = new RegExp(
  [
    /\bif\s+no\s+(?:reply|response|feedback|message|answer)\s+within\s+\d/i.source,
    /\b\d+\s*(?:hours?|days?)\s+after\s+(?:sending|replying|the\s+(?:reply|message|email|invitation))/i.source,
    /\bwithin\s+\d+\s*(?:hours?|business\s+days?|days?)\s+of\s+(?:the\s+)?(?:reply|message|interview|email)/i.source,
  ].join('|'),
  'i',
);

/**
 * Concatenate all human-facing text fields of a distilled output. Plain join,
 * NOT JSON.stringify — JSON.stringify escapes inner quotes (`"` → `\"`) which
 * breaks the context_ref regex that looks for unescaped quote delimiters.
 */
function flattenSkillText(out: DistilledOutput): string {
  const skillParts = (out.skills ?? []).flatMap(s => [s.name, s.description, s.instruction]);
  return [...skillParts, out.userInstructions ?? '', out.instructionsMd ?? ''].join('\n');
}

/**
 * Test whether the catalog declares any entity field that could anchor a date-range
 * predicate (I1's catalog-side trigger). Pattern-only — no vendor names.
 */
export function catalogHasDeadlineField(
  catalogSchemasByType: Record<string, Record<string, unknown>>,
  inScopeConnectorTypes: Set<string>,
): boolean {
  const DEADLINE_FIELD_RE = /(?:expir|renewal|due_?date|hire_?date|start_?date|close_?date|last_(?:contacted|activity|message))/i;
  for (const [connectorType, entities] of Object.entries(catalogSchemasByType)) {
    if (inScopeConnectorTypes.size > 0 && !inScopeConnectorTypes.has(connectorType)) continue;
    for (const fields of Object.values(entities)) {
      if (DEADLINE_FIELD_RE.test(JSON.stringify(fields))) return true;
    }
  }
  return false;
}

// ─── Invariants ───────────────────────────────────────────────────────────

export const INVARIANTS: Invariant[] = [
  {
    id: 'I1',
    description: 'Deadline keyed to a durable catalog-declared field → companionCron + date-range predicate, no schedule_followup paired',
    triggersOnInput: (doc, catalog) => {
      const inScope = new Set<string>(
        (doc.connectorRefs ?? []).map(r => r.connectorType).filter(Boolean) as string[],
      );
      const hasDeadlineLanguage = /\b(?:renewal|expir|due|aging|overdue|days?\s+before|days?\s+after\s+(?:hire|start|signup))/i.test(doc.responsibilities ?? '');
      const catalogHasField = catalogHasDeadlineField(catalog, inScope);
      if (!hasDeadlineLanguage) return { triggers: false, reason: 'no per-record deadline language in responsibilities' };
      if (!catalogHasField) return { triggers: false, reason: 'responsibilities mention deadline but catalog declares no anchoring field (falls to I2)' };
      return { triggers: true, reason: 'responsibilities + catalog both present' };
    },
    satisfiedByOutput: (out) => {
      const hasCompanion = (out.triggerConfig?.companionCrons?.length ?? 0) > 0;
      const allSkillText = flattenSkillText(out);
      const hasDateRangePredicate = /(?:expir|renewal|due|hire|start|close)_?date\s*(?:[-+]\s*now\s*(?:[<>≤≥=]|BETWEEN|∈|in\s*\[)|\s*\+\s*\d+\s*(?:day|business\s+day)s?\s*==\s*today)/i.test(allSkillText);
      const hasScheduleFollowup = /schedule_followup/i.test(allSkillText);
      if (!hasCompanion) return { ok: false, reason: 'I1 triggered but no companionCron in output' };
      if (!hasDateRangePredicate) return { ok: false, reason: 'I1 triggered but no date-range predicate in skill/instruction text' };
      if (hasScheduleFollowup) return { ok: false, reason: 'I1 triggered and output mixes schedule_followup — see §3.1 case (c) "do not mix"' };
      return { ok: true, reason: '' };
    },
  },
  {
    id: 'I2',
    description: 'Deadline keyed to transient event → schedule_followup; cancel_followup paired when responsibilities describe a cancel condition',
    triggersOnInput: (doc, catalog) => {
      const inScope = new Set<string>(
        (doc.connectorRefs ?? []).map(r => r.connectorType).filter(Boolean) as string[],
      );
      const hasEventKeyed = RESP_HAS_EVENT_KEYED_DEADLINE.test(doc.responsibilities ?? '');
      // I2 fires when responsibilities have event-keyed deadlines OR when responsibilities
      // have any per-record deadline but I1's catalog-side trigger fails.
      const hasGenericDeadline = /\b(?:follow[\s-]*up|reminder|escalate|check[\s-]*in|chase)\b/i.test(doc.responsibilities ?? '');
      const i1CatalogTrigger = catalogHasDeadlineField(catalog, inScope);
      if (hasEventKeyed) return { triggers: true, reason: 'event-keyed deadline language present' };
      if (hasGenericDeadline && !i1CatalogTrigger) return { triggers: true, reason: 'per-record deadline language without catalog anchor — falls to I2' };
      return { triggers: false, reason: 'no follow-up/reminder/check-in language present' };
    },
    satisfiedByOutput: (out) => {
      const allSkillText = flattenSkillText(out);
      const hasScheduleFollowup = /schedule_followup/i.test(allSkillText);
      if (!hasScheduleFollowup) return { ok: false, reason: 'I2 triggered but distilled output never references schedule_followup' };
      return { ok: true, reason: '' };
    },
  },
  {
    id: 'I3',
    description: 'Multiple sequential deadlines on the same entity → context_ref carries a milestone suffix',
    triggersOnInput: (doc) => {
      const has = RESP_HAS_SEQUENTIAL_DEADLINES.test(doc.responsibilities ?? '');
      return { triggers: has, reason: has ? 'sequential-deadline language present' : 'no sequential-deadline language' };
    },
    satisfiedByOutput: (out) => {
      const allSkillText = flattenSkillText(out);
      // Find every context_ref construction shown in output
      const contextRefMatches = Array.from(allSkillText.matchAll(/context_ref\s*[:=]\s*["'`]([^"'`]+)["'`]/g));
      if (contextRefMatches.length === 0) {
        // I3 triggered + no context_ref appears at all → schedule_followup wasn't produced; failure
        return { ok: false, reason: 'I3 triggered but no context_ref examples in output' };
      }
      // Every example must have a milestone suffix — checked by presence of an N-style segment
      const MILESTONE_SUFFIX_RE = /_(?:touch|day|step|milestone|followup|attempt|round)_(?:\$\{n\}|\$\{?\d+\}?|\d+)$/;
      // "bare entity id" = a single entity + variable id with no milestone suffix.
      // The variable name in the braces can be any identifier (`${id}`, `${entityId}`,
      // `${entity_id}`); the original plan regex required the name to literally end
      // in `id`/`Id`, which incorrectly accepted `lead_${something}` and rejected
      // the standard `lead_${id}` form. Loosened to any identifier here.
      const bareEntityIdRE = /^[a-z_]+_\$\{[a-zA-Z_][a-zA-Z0-9_]*\}$/;
      const bad: string[] = [];
      for (const m of contextRefMatches) {
        const ref = m[1];
        if (bareEntityIdRE.test(ref) && !MILESTONE_SUFFIX_RE.test(ref)) {
          bad.push(ref);
        }
      }
      if (bad.length > 0) {
        return { ok: false, reason: `I3 triggered but context_ref(s) missing milestone suffix: ${bad.join(', ')} — silent-bug collision` };
      }
      return { ok: true, reason: '' };
    },
  },
  {
    id: 'I4',
    description: 'Responsibilities use "business days" → distilled skill text shows weekday-aware math',
    triggersOnInput: (doc) => {
      const has = RESP_HAS_BUSINESS_DAYS.test(doc.responsibilities ?? '') || RESP_HAS_BUSINESS_DAYS.test(doc.additionalContext ?? '');
      return { triggers: has, reason: has ? 'business-days language present' : 'no business-days language' };
    },
    satisfiedByOutput: (out) => {
      const allSkillText = flattenSkillText(out);
      // Weekday-aware math: either explicit weekday names (Mon/Tue/etc.) AND day-of-week
      // arithmetic, OR a "(2|4|6)*86400 if firing Mon-Wed else (4|6|8)*86400"-style branch.
      const hasWeekdayNames = /\b(?:Mon|Tue|Wed|Thu|Fri)(?:day)?\b/.test(allSkillText);
      const hasDayOfWeekArith = /\b(?:weekday|day[\s-]of[\s-]week|skip(?:s|ping)?\s+(?:weekend|sat|sun))/i.test(allSkillText);
      // Bare `N * 86400` for N matching common business-day values is a fail signal
      const BARE_CALENDAR_MULT = /\b(?:2|3|4|5)\s*\*\s*86400\b/;
      const hasBareCalendar = BARE_CALENDAR_MULT.test(allSkillText);
      if (!hasWeekdayNames && !hasDayOfWeekArith) {
        return { ok: false, reason: 'I4 triggered but no weekday-aware math in skill text' };
      }
      if (hasBareCalendar) {
        return { ok: false, reason: 'I4 triggered and skill text contains bare N*86400 for business-day count — calendar shortcut' };
      }
      return { ok: true, reason: '' };
    },
  },
  {
    id: 'I5',
    description: 'Distilled output contains reactiveSubscriptions → skill text mentions forward-only AND breach-clearing',
    triggersOnInput: () => ({ triggers: false, reason: 'I5 is output-driven; classified at output stage' }),
    satisfiedByOutput: (out) => {
      const hasReactive = (out.triggerConfig?.reactiveSubscriptions?.length ?? 0) > 0;
      if (!hasReactive) return { ok: true, reason: 'no reactiveSubscriptions in output; I5 not applicable' };
      const allSkillText = flattenSkillText(out);
      const hasForwardOnly = /\bforward[\s-]only\b|\bno\s+backfill\b|\bevents?\s+(?:emitted\s+)?after\b/i.test(allSkillText);
      const hasBreachClearing = /\b(?:clear(?:s|ing)?\s+the\s+(?:predicate|breach|condition)|stop\s+(?:matching|firing)|until\s+(?:the\s+)?(?:action|state)\s+(?:clears|changes))/i.test(allSkillText);
      if (!hasForwardOnly) return { ok: false, reason: 'I5: reactiveSubscription present but no forward-only mention in skill text' };
      if (!hasBreachClearing) return { ok: false, reason: 'I5: reactiveSubscription present but no breach-clearing dependency mention in skill text' };
      return { ok: true, reason: '' };
    },
  },
];
