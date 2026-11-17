// Distill-time structural analyzer for the produced triggerConfig.
//
// Runs in-process after distillInternalAgentWithProgress receives an LLM
// tool-call response and BEFORE the result is returned to callers. The
// analyzer's job is structural: it inspects the triggerConfig + skills text
// the LLM emitted, cross-references them against the bound connectors'
// real per-entity field schemas (CONNECTOR_ENTITY_SCHEMAS, projected onto
// the catalog), and produces a list of violations. The caller uses the
// violation list to decide whether to retry with feedback or surface a
// usable error.
//
// Design notes:
//   • No regex matching over flattened skill text. That was the wrong layer.
//   • Reactive-subscription filter ASTs are typed — those checks are
//     high-confidence (reject on violation).
//   • Companion-cron objectives are freeform text — extraction is via a
//     conservative identifier regex; results are low-confidence (warn only).
//   • Skill `schedule_followup(...)` references are also freeform — same
//     low-confidence handling.
//   • The analyzer never reads template ids or any other agent identity.
//     It runs uniformly against every distilled agent, custom or template.

import type { DistillOutput } from './distill-service';
import { cronMatchesExpected } from './cadence-parse';
import { deliversEvents } from './event-deliverability';
import type { ConnectorCatalogResponse, ConnectorDef } from '@liftoffos/connector-types';

// ── Rule identifiers ────────────────────────────────────────────────────────

export type AnalyzerRule =
  | 'case_c_mixed_primitives'
  | 'reactive_predicate_undeclared_field'
  | 'companion_predicate_undeclared_field'
  | 'schedule_followup_on_anchored_field'
  | 'manual_trigger_with_reactive_responsibilities'
  | 'cron_trigger_with_event_topic_available'
  | 'soft_directive_uncheckable'
  // F5: a routine that would pause, disable, or delete the team member that
  // runs it — self-disabling on a schedule, with no error to notice.
  | 'self_disabling_routine'
  // A routine that says it needs no model but gives no command to run instead.
  | 'no_agent_without_script'
  // The person stated an exact cadence and the derived trigger set does not
  // contain it — the "Monday brief quietly becomes a daily one" class, made
  // a retried generation error instead of a silent wrong schedule.
  | 'expected_cadence_missing'
  // The person stopped a routine and the derived trigger set still contains
  // its cadence. The inverse of expected_cadence_missing: an absence cannot
  // be verified from the guidance text (the stopped line was removed from
  // it), so the caller states what was stopped and this rule requires the
  // trigger set not to carry it.
  | 'stopped_cadence_present';

export interface AnalyzerViolation {
  rule: AnalyzerRule;
  /** High-confidence violations (typed ASTs) → block on retry. */
  severity: 'reject' | 'warn';
  message: string;
  detail?: Record<string, unknown>;
}

// ── Catalog projection helpers ──────────────────────────────────────────────

type JsonSchemaLike = Record<string, unknown>;
type EntitySchemaMap = Record<string, JsonSchemaLike>;

/**
 * Build the `{entityType → schema}` map restricted to the bound connectors.
 * The schema's declared field names are the legitimate predicate paths the
 * analyzer recognizes; anything else is "ghost field" territory.
 */
export function buildBoundEntitySchemas(
  catalog: ConnectorCatalogResponse,
  boundConnectorTypes: Set<string>,
): Record<string, EntitySchemaMap> {
  const out: Record<string, EntitySchemaMap> = {};
  for (const c of catalog.connectors) {
    if (!boundConnectorTypes.has(c.type)) continue;
    const schemas = (c.entitySchemas ?? {}) as Record<string, JsonSchemaLike>;
    out[c.type] = schemas;
  }
  return out;
}

/**
 * Walks a single connector's schemas and returns the flat set of declared
 * property names. Nested objects' inner property names are included —
 * a predicate could reference `addresses.0.city`, and we don't want to
 * false-positive on `city`.
 *
 * An empty result is meaningful: it means the connector publishes no schemas
 * yet (catalog migration not complete for that connector), and the caller
 * must fail open rather than rejecting every leaf as undeclared.
 */
function collectDeclaredFieldNamesForConnector(
  schemas: EntitySchemaMap,
): Set<string> {
  const names = new Set<string>();
  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const props = obj.properties as Record<string, unknown> | undefined;
    if (props && typeof props === 'object') {
      for (const key of Object.keys(props)) {
        names.add(key);
        walk(props[key]);
      }
    }
    const items = obj.items as Record<string, unknown> | undefined;
    if (items && typeof items === 'object') walk(items);
  }
  for (const schema of Object.values(schemas)) {
    walk(schema);
  }
  return names;
}

/**
 * Union of declared field names across every bound connector. Used by
 * companion-cron text-token scanning (Rule 3) — companion objectives
 * don't carry a connector reference so all declared fields are in scope.
 *
 * Returns an empty set iff no bound connector has published any schemas;
 * callers must fail open in that case.
 */
function collectDeclaredFieldNamesGlobal(
  byConnector: Record<string, EntitySchemaMap>,
): Set<string> {
  const names = new Set<string>();
  for (const schemas of Object.values(byConnector)) {
    for (const name of collectDeclaredFieldNamesForConnector(schemas)) {
      names.add(name);
    }
  }
  return names;
}

/**
 * Names of fields declared with a `.describe(...)` mentioning "anchor" or
 * standard deadline-anchor language — these are the catalog-declared
 * deadline anchors used by Case (a). A schedule_followup reference to
 * the same field name is a Case (a) vs Case (b) confusion (Rule 4).
 *
 * Implemented by walking the JSON Schema and looking at each property's
 * `description` field. The Zod schemas in the connector-service normalizers
 * use `.describe('… — anchor for "alert N days before…')` to mark these.
 */
function collectAnchorFieldNames(
  byConnector: Record<string, EntitySchemaMap>,
): Set<string> {
  const names = new Set<string>();
  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    const obj = node as Record<string, unknown>;
    const props = obj.properties as Record<string, unknown> | undefined;
    if (props && typeof props === 'object') {
      for (const [key, value] of Object.entries(props)) {
        if (value && typeof value === 'object') {
          const v = value as Record<string, unknown>;
          const desc = typeof v.description === 'string' ? v.description : '';
          if (/anchor for|deadline anchor|before close|before due|before received|N days before|N hours before|N minutes before/i.test(desc)) {
            names.add(key);
          }
          walk(v);
        }
      }
    }
    const items = obj.items as Record<string, unknown> | undefined;
    if (items && typeof items === 'object') walk(items);
  }
  for (const schemas of Object.values(byConnector)) {
    for (const schema of Object.values(schemas)) {
      walk(schema);
    }
  }
  return names;
}

// ── Predicate-AST walking ───────────────────────────────────────────────────

/**
 * Extract the leaf `path` values from a reactiveSubscription filter AST.
 * The AST grammar lives in src/agent-templates/validator.ts. Only the leaf
 * comparison nodes carry `path` — boolean combinators (and/or/not) don't.
 */
export function extractFilterPaths(filter: unknown): string[] {
  const out: string[] = [];
  function walk(node: unknown): void {
    if (!node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (typeof n.path === 'string') {
      out.push(n.path);
    }
    if (Array.isArray(n.operands)) {
      for (const child of n.operands) walk(child);
    }
    if (n.operand) walk(n.operand);
  }
  walk(filter);
  return out;
}

/**
 * Reduce a JSON path to its leaf identifier — `addresses.0.city` → `city`,
 * `data.deal.closeDate` → `closeDate`. We only check the leaf because
 * declared field names in the entity schemas are unprefixed.
 */
function pathLeaf(path: string): string {
  const parts = path.split('.');
  return parts[parts.length - 1] ?? path;
}

// ── Companion-cron & skill-text field-name extraction (low confidence) ──────

/**
 * Conservative identifier extractor. Pulls out tokens that look like camelCase
 * or snake_case field references with hard word boundaries. False positives
 * are tolerated — Rules 3/4 are warn-only.
 */
function extractIdentifierTokens(text: string): string[] {
  if (!text) return [];
  const out = new Set<string>();
  const re = /\b([a-z][a-zA-Z0-9]*[A-Z][a-zA-Z0-9]*|[a-z][a-z0-9]*_[a-z0-9_]+)\b/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    out.add(m[1]);
  }
  return Array.from(out);
}

/**
 * Find `schedule_followup(...)` references in skill instruction text. We
 * pull the rough call site so Rule 4 can report what it found.
 */
function findScheduleFollowupCalls(instruction: string): string[] {
  if (!instruction) return [];
  const out: string[] = [];
  const re = /schedule_followup\s*\(([^)]*)\)/gi;
  let m: RegExpExecArray | null;
  while ((m = re.exec(instruction)) !== null) {
    out.push(m[1] ?? '');
  }
  return out;
}

// ── Trigger config shape (narrowed view) ────────────────────────────────────
//
// distill-service's DistillTriggerConfig TS interface is a subset; the LLM
// actually produces the fuller shape declared in TRIGGER_CONFIG_SCHEMA, with
// companionCrons and reactiveSubscriptions. We narrow to what the analyzer
// needs without changing the public DistillTriggerConfig type.

interface TriggerConfigViewed {
  type?: string;
  cronExpr?: string;
  eventTopic?: string;
  companionCrons?: Array<{
    label?: string;
    cronExpr?: string;
    timezone?: string;
    objective?: string;
    script?: unknown;
    noAgent?: boolean;
  }>;
  reactiveSubscriptions?: Array<{
    label?: string;
    source?: {
      kind?: string;
      connectorRef?: string;
      entityType?: string;
      topic?: string;
      fn?: string;
      args?: Record<string, unknown>;
      pollIntervalSeconds?: number;
      extractPath?: string;
    };
    filter?: unknown;
    window?: unknown;
    cooldownSeconds?: number;
    objective?: string;
  }>;
  reasoning?: string;
}

// ── Detection rules ─────────────────────────────────────────────────────────

/**
 * Rule 1 — case (c) mixed primitives.
 *
 * Case (c) is forbidden by the prompt: a companionCron that scans for a
 * date-range predicate AND emits schedule_followup calls keyed to the same
 * entity-deadline is double-scheduling. The detection heuristic:
 *   1. there is at least one companionCron whose objective text mentions
 *      a date-range pattern ("before close", "due in N days", etc.); AND
 *   2. there is at least one skill instruction referencing schedule_followup
 *      with a context_ref that mentions the same entity noun.
 *
 * False positives are possible (the language is fuzzy), so severity is
 * `warn` rather than `reject`. Operators can still treat this as a strong
 * signal but the LLM gets a chance to fix on retry without being blocked.
 */
function detectMixedPrimitives(out: DistillOutput): AnalyzerViolation[] {
  const tc = (out as { triggerConfig?: TriggerConfigViewed }).triggerConfig ?? {};
  const companionObjectives = (tc.companionCrons ?? [])
    .map(c => c.objective ?? '')
    .filter(Boolean);
  if (companionObjectives.length === 0) return [];

  const datePred = /\b(before\s+(?:due|close|expir|renew)|in\s+\d+\s+(?:day|hour)|N\s+days?\s+before)\b/i;
  const objectivesWithDatePred = companionObjectives.filter(o => datePred.test(o));
  if (objectivesWithDatePred.length === 0) return [];

  const skills = (out as { skills?: Array<{ instruction?: string }> }).skills ?? [];
  const followupCalls = skills.flatMap(s => findScheduleFollowupCalls(s.instruction ?? ''));
  if (followupCalls.length === 0) return [];

  // Heuristic overlap: does any followup call mention an entity noun that
  // also appears in the companion objective? Patterns like `deal_${id}` have
  // a word char (underscore) right after the noun, so `\b…\b` would miss the
  // match — we use a relaxed boundary that fires on bare word and on
  // identifier prefixes (`deal_…`, `dealId`).
  const entityNounRe = /(?<![a-zA-Z])(deal|invoice|account|lead|contract|opportunity|ticket|task|issue|renewal)s?(?![a-zA-Z])/gi;
  const collectNouns = (text: string): string[] => {
    const out: string[] = [];
    let m: RegExpExecArray | null;
    while ((m = entityNounRe.exec(text)) !== null) {
      out.push(m[1].toLowerCase());
    }
    return out;
  };
  const objectiveEntities = new Set(
    objectivesWithDatePred.flatMap(collectNouns),
  );
  const overlapping = followupCalls.filter(call => {
    const callNouns = collectNouns(call);
    return callNouns.some(n => objectiveEntities.has(n));
  });
  if (overlapping.length === 0) return [];

  return [{
    rule: 'case_c_mixed_primitives',
    severity: 'warn',
    message:
      'companionCron objective references a per-record deadline AND a skill schedules a ' +
      'schedule_followup keyed to the same entity. Pick exactly one primitive — case (a) ' +
      '(daily companion sweep with date-range predicate, no schedule_followup) OR case (b) ' +
      '(schedule_followup at the moment of the triggering event, no companion sweep). ' +
      'Mixing creates two scheduling sources on the same timeline.',
    detail: {
      companionObjectives: objectivesWithDatePred,
      scheduleFollowupCalls: overlapping,
    },
  }];
}

/**
 * Rule 2 — reactive predicate references undeclared field.
 *
 * Walks every reactiveSubscription's filter AST and asserts every leaf
 * `path` resolves to a field name declared in the SUBSCRIPTION'S target
 * connector's entity schema. Mismatches are high-confidence (typed AST):
 * reject.
 *
 * Per-subscription scoping is important — looking up against the union of
 * all bound connectors would let a Salesforce-shaped path slip through on
 * a HubSpot subscription. The connectorRef on the subscription's source is
 * the authoritative scope.
 *
 * `system_event` (no connectorRef — the source is a platform event topic
 * unrelated to any connector's entity surface) and `computed_metric`
 * (filter is over the function result, not entity fields) are out of
 * scope for this rule and skipped.
 *
 * If the catalog has no entry for the named connectorRef the subscription
 * is rejected: the LLM cannot subscribe against a connector that isn't
 * bound to this agent.
 */
function detectGhostReactiveFields(
  out: DistillOutput,
  byConnector: Record<string, EntitySchemaMap>,
): AnalyzerViolation[] {
  const tc = (out as { triggerConfig?: TriggerConfigViewed }).triggerConfig ?? {};
  const subs = tc.reactiveSubscriptions ?? [];
  const violations: AnalyzerViolation[] = [];

  for (const sub of subs) {
    if (!sub.filter) continue;
    const kind = sub.source?.kind;
    if (kind !== 'connector_event') continue;
    const connectorRef = sub.source?.connectorRef;
    if (!connectorRef) continue;

    const schemas = byConnector[connectorRef];
    if (!schemas) {
      violations.push({
        rule: 'reactive_predicate_undeclared_field',
        severity: 'reject',
        message:
          `reactiveSubscription "${sub.label ?? '<unnamed>'}" targets connector ` +
          `"${connectorRef}" which is not in the agent's bound connector set.`,
        detail: { label: sub.label, connectorRef },
      });
      continue;
    }

    const declared = collectDeclaredFieldNamesForConnector(schemas);
    const paths = extractFilterPaths(sub.filter);
    const undeclared = paths.filter(p => !declared.has(pathLeaf(p)));
    if (undeclared.length === 0) continue;

    violations.push({
      rule: 'reactive_predicate_undeclared_field',
      severity: 'reject',
      message:
        `reactiveSubscription "${sub.label ?? '<unnamed>'}" filter references field path(s) ` +
        `not declared in connector "${connectorRef}"'s entity schema: ${undeclared.join(', ')}. ` +
        'Either restate the predicate against a real published field, or use ' +
        'source.kind="computed_metric" with an explicit fn.',
      detail: { label: sub.label, connectorRef, undeclaredPaths: undeclared },
    });
  }
  return violations;
}

/**
 * Rule 3 — companionCron objective text references undeclared field.
 *
 * Low-confidence text extraction (companion objectives are freeform prose,
 * not a typed AST). Warn only.
 */
function detectGhostCompanionFields(
  out: DistillOutput,
  declaredFieldNames: Set<string>,
): AnalyzerViolation[] {
  const tc = (out as { triggerConfig?: TriggerConfigViewed }).triggerConfig ?? {};
  const crons = tc.companionCrons ?? [];
  const violations: AnalyzerViolation[] = [];
  for (const cron of crons) {
    const tokens = extractIdentifierTokens(cron.objective ?? '');
    const undeclared = tokens.filter(t => !declaredFieldNames.has(t));
    // Only warn when the cron looks like it's referencing a real field
    // shape — i.e. at least one snake_case_or_camelCase token in the
    // objective is undeclared. Bare prose without those tokens won't flag.
    if (undeclared.length > 0 && tokens.length !== undeclared.length) {
      // mixed (some declared, some not) — likely a real ghost-field reference
      violations.push({
        rule: 'companion_predicate_undeclared_field',
        severity: 'warn',
        message:
          `companionCron "${cron.label ?? '<unnamed>'}" objective mentions field-name-shaped ` +
          `token(s) not declared in any bound connector's entity schema: ${undeclared.join(', ')}. ` +
          'If these are predicates, rewrite using a real published field. If they are prose, ignore.',
        detail: { label: cron.label, undeclaredTokens: undeclared },
      });
    }
  }
  return violations;
}

/**
 * A routine marked as needing no model, with nothing to run in its place.
 *
 * `noAgent` means "the command IS the job". Without a command there is no job:
 * the routine fires on schedule forever and does nothing, and because it never
 * errors, nothing surfaces it. `reject`, so the distiller's retry loop
 * self-corrects into either a real script or an ordinary routine.
 */
function detectNoAgentWithoutScript(out: DistillOutput): AnalyzerViolation[] {
  const tc = (out as { triggerConfig?: TriggerConfigViewed }).triggerConfig ?? {};
  const violations: AnalyzerViolation[] = [];
  for (const cron of tc.companionCrons ?? []) {
    if (cron.noAgent !== true) continue;
    const script = cron.script;
    const hasScript = typeof script === 'string'
      ? script.trim().length > 0
      : Array.isArray(script) && script.some((a) => typeof a === 'string' && a.trim().length > 0);
    if (hasScript) continue;
    violations.push({
      rule: 'no_agent_without_script',
      severity: 'reject',
      message:
        `companionCron "${cron.label ?? '<unnamed>'}" sets noAgent but has no script. ` +
        'noAgent means the command is the whole job, so it needs a command. Either add a ' +
        'script (an array of argument strings), or drop noAgent and let the routine run normally.',
      detail: { label: cron.label },
    });
  }
  return violations;
}

/**
 * Rule 4 — schedule_followup keyed to a field that's a declared deadline
 * anchor. Anchored fields (e.g. `closeDate`, `dueDate`, `expiry_date`)
 * should be served by Case (a) — daily companionCron with a date-range
 * predicate — not by schedule_followup at the moment of an event, since
 * the entity's durable deadline can be swept directly.
 *
 * Warn only — call-site text is fuzzy.
 */
function detectScheduleFollowupOnAnchoredField(
  out: DistillOutput,
  anchorFieldNames: Set<string>,
): AnalyzerViolation[] {
  const skills = (out as { skills?: Array<{ name?: string; instruction?: string }> }).skills ?? [];
  const violations: AnalyzerViolation[] = [];
  for (const s of skills) {
    const calls = findScheduleFollowupCalls(s.instruction ?? '');
    for (const call of calls) {
      const tokens = extractIdentifierTokens(call);
      const anchored = tokens.filter(t => anchorFieldNames.has(t));
      if (anchored.length > 0) {
        violations.push({
          rule: 'schedule_followup_on_anchored_field',
          severity: 'warn',
          message:
            `skill "${s.name ?? '<unnamed>'}" calls schedule_followup with argument(s) ` +
            `naming a field declared as a deadline anchor (${anchored.join(', ')}). ` +
            'Prefer Case (a): a daily companionCron with a date-range predicate over the ' +
            'anchor field. Reserve schedule_followup for event-keyed deadlines that have no ' +
            'durable "next-action-at" field on the connector entity.',
          detail: { skill: s.name, anchoredFields: anchored, call },
        });
      }
    }
  }
  return violations;
}

// ── Rule 5: manual_trigger_with_reactive_responsibilities ─────────────────
//
// The distill LLM has historically picked `type: "manual"` when it sees
// reactive responsibilities ("respond to new emails", "review every new PR")
// but cannot find an EVENT TOPIC for the connector. The runtime then pauses
// the scheduler because type=manual means "human invokes by hand" — and the
// reactive contract silently breaks. This rule catches the contradiction:
// reactive verbs in responsibilities AND type=manual on the primary trigger.
// Severity: reject. The retry feedback tells the LLM to use cron polling.

/** Phrases that indicate the agent must react to incoming data. If any of
 *  these appear in the role + responsibilities text, the primary trigger
 *  cannot be `manual` — the agent has to be polling or event-driven. */
const REACTIVE_KEYWORD_PATTERNS: RegExp[] = [
  /\bmonitor(?:s|ing)?\b/i,
  /\bwatch(?:es|ing)?\b/i,
  /\bpoll(?:s|ing)?\b/i,
  /\b(?:react|respond)(?:s|ing)?\s+to\b/i,
  /\b(?:when|whenever|as\s+soon\s+as|every|each)\s+(?:a\s+)?new\b/i,
  /\balert\s+when\b/i,
  /\bnotify\s+when\b/i,
  /\bfire\s+when\b/i,
  /\bincoming\b/i,
  /\binbox\b/i,
  /\bnewly\s+(?:opened|created|received|posted)\b/i,
  // Every pattern above needs a specific frame — "monitor", "inbox", or "new"
  // preceded by when/every/each — so plain "check for new pull requests" and
  // "reviews open pull requests" read as non-reactive and skip Rule 6 entirely.
  /\b(?:check|scan|look|search)(?:s|ing)?\s+for\s+new\b/i,
  /\bnew\s+(?:pull\s+requests?|prs?|issues?|tickets?|messages?|emails?|comments?|commits?|records?|orders?|leads?|events?)\b/i,
  /\bopen\s+(?:pull\s+requests?|prs?|issues?|tickets?)\b/i,
];

function hasReactiveKeyword(text: string): boolean {
  return REACTIVE_KEYWORD_PATTERNS.some((re) => re.test(text));
}

/** Surface the first matching keyword for the violation message. */
function firstReactiveMatch(text: string): string | undefined {
  for (const re of REACTIVE_KEYWORD_PATTERNS) {
    const m = text.match(re);
    if (m) return m[0];
  }
  return undefined;
}

function detectManualTriggerWithReactiveResponsibilities(
  out: DistillOutput,
  responsibilities: string,
): AnalyzerViolation[] {
  if (out.triggerConfig?.type !== 'manual') return [];
  if (!hasReactiveKeyword(responsibilities)) return [];
  const hit = firstReactiveMatch(responsibilities) ?? 'reactive verb';
  return [{
    rule: 'manual_trigger_with_reactive_responsibilities',
    severity: 'reject',
    message:
      `Primary trigger is "manual" but responsibilities require reactive behavior ` +
      `(matched: "${hit}"). The scheduler pauses agents whose primary trigger is manual, ` +
      `so the reactive contract will silently break. Use cron polling (e.g. "*/1 * * * *") ` +
      `as the primary trigger when no event topic is available, or "event" with a verbatim ` +
      `topic from EVENT TOPICS if one exists.`,
    detail: { matchedKeyword: hit, currentTriggerType: 'manual' },
  }];
}

// ── Rule 6: cron_trigger_with_event_topic_available ──────────────────────
//
// The distill prompt teaches the LLM to prefer `type: "event"` whenever the
// responsibilities are reactive AND an event topic is published for a bound
// connector — but it's a soft preference and the LLM has historically defaulted
// to `cron */1 * * * *` for Gmail/Outlook/GitHub anyway. Real cost: a
// "Customer Support Representative" with the Gmail connector ends up cron-
// polling once a minute, escalating every minute, and never wiring into the
// inbound-email event stream. Composio + connector-service publish a real
// `email.received` topic — there is no reason to spin a per-minute cron when
// the event surface exists.
//
// Rule 6 makes that preference deterministic. Conditions:
//   1. Primary trigger is `cron`.
//   2. At least one bound connector publishes an event topic for an entity
//      whose polling row can actually deliver (see event-deliverability).
//   3. Role/responsibilities text contains a reactive keyword (Rule 5 helper).
//   4. Role/responsibilities text does NOT contain an explicit-cron phrase
//      ("every minute", "daily at 9am", "every Monday", a literal cron expr,
//      etc.). If the user pinned a schedule, respect it.
//
// Severity: reject. The retry feedback hands the LLM the exact event topic(s)
// available, so it has the right string to copy verbatim.

/** Phrases that lock the trigger as cron-by-intent. If any appears in the
 *  responsibilities text, Rule 6 does not fire — the user wants a schedule. */
const EXPLICIT_CRON_KEYWORD_PATTERNS: RegExp[] = [
  /\bevery\s+\d+\s+(?:minute|hour|day|week|month|second)s?\b/i,
  /\bevery\s+(?:minute|hour|day|week|month|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekday|night|morning|afternoon|evening)\b/i,
  /\b(?:daily|hourly|weekly|monthly|nightly)\b/i,
  /\bat\s+\d{1,2}(?::\d{2})?\s*(?:am|pm)?\b/i,
  /\b\d{1,2}:\d{2}\s*(?:am|pm)?\b/i,
  /\bonce\s+(?:a|per)\s+(?:minute|hour|day|week|month)\b/i,
  /\bon\s+a\s+(?:schedule|cadence)\b/i,
  /\bperiodically\b/i,
  /\*\/\d+\s+[\d*]/, // literal cron snippet like "*/5 * * * *"
];

function hasExplicitCronIntent(text: string): boolean {
  return EXPLICIT_CRON_KEYWORD_PATTERNS.some((re) => re.test(text));
}

/** A pinned cadence faster than an hour: a request for immediacy in a
 *  schedule's clothes.
 *
 *  Deliberately excludes "hourly", "daily at 9am" and "every Monday" — there
 *  the clock is the requirement, and the escape below keeps honouring it. */
const SUB_HOURLY_CRON_PATTERNS: RegExp[] = [
  /\bevery\s+(\d+)\s+minutes?\b/i,
  /\bevery\s+minute\b/i,
  /\bonce\s+(?:a|per)\s+minute\b/i,
  /\bevery\s+(\d+)\s+seconds?\b/i,
  /\bevery\s+second\b/i,
];

/** A literal cron expression in the responsibilities: a hard pin.
 *
 *  Prose like "every 5 minutes" is how someone asks for immediacy; a raw cron
 *  interval is someone who knows what a cron is and chose one. */
const LITERAL_CRON_EXPRESSION = /\*\/\d+\s+[\d*]/;

function hasLiteralCronExpression(text: string): boolean {
  return LITERAL_CRON_EXPRESSION.test(text);
}

function hasSubHourlyCronIntent(text: string): boolean {
  return SUB_HOURLY_CRON_PATTERNS.some((re) => re.test(text));
}

/** Does the role produce one BATCHED output per fire, rather than acting on
 *  each record as it arrives?
 *
 *  A 15-minute digest is sub-hourly and reactive-sounding, but its interval is
 *  the batching window, and an event trigger would emit one message per record
 *  instead of the one summary asked for.
 *
 *  Tight on purpose: "summary OF" is aggregate phrasing, while a per-record
 *  "summary comment" is not, so a bare /summar/ match would misread ordinary
 *  per-record roles as digests. */
const AGGREGATE_OUTPUT_PATTERNS: RegExp[] = [
  /\bdigest\b/i,
  /\bround-?up\b/i,
  /\bsummary\s+of\b/i,
  /\bsummar(?:ise|ize)\s+(?:all|the|newly|new)\b/i,
  /\bbatch(?:ed|es)?\s+(?:up|together|of)\b/i,
];

function hasAggregateOutputIntent(text: string): boolean {
  return AGGREGATE_OUTPUT_PATTERNS.some((re) => re.test(text));
}

/** Collect the deduplicated set of `{connector → [topics]}` for every bound
 *  connector that can actually DELIVER an event.
 *
 *  This claimed to mirror distill-service's buildEventTopicsText "so the
 *  analyzer's available-topic set matches what the LLM was shown". It did not.
 *  It filtered on `listImplemented` (87 polling rows) while the prompt half
 *  filtered on `eventTrigger` (19). For the 68 rows in between — GitHub's
 *  PullRequest among them — the model was told no integration could deliver an
 *  event, and then rejected for using cron and ordered to copy a topic verbatim
 *  out of that empty list. Unsatisfiable: three retries, then a 500, and the
 *  agent could not be redistilled at all.
 *
 *  Both halves now import the one predicate, so the claim in this comment is
 *  enforced by the code rather than asserted by it. */
function collectAvailableEventTopics(
  catalog: ConnectorCatalogResponse,
  boundConnectorTypes: Set<string>,
): Array<{ connectorType: string; topics: string[] }> {
  const out: Array<{ connectorType: string; topics: string[] }> = [];
  for (const def of catalog.connectors) {
    if (!boundConnectorTypes.has(def.type)) continue;
    if (!def.polling) continue;
    const topics = [
      ...new Set(
        def.polling.filter(deliversEvents).flatMap((p) => p.eventTopics),
      ),
    ];
    if (topics.length === 0) continue;
    out.push({ connectorType: def.type, topics });
  }
  return out;
}

function detectCronTriggerWithEventTopicAvailable(
  out: DistillOutput,
  responsibilities: string,
  catalog: ConnectorCatalogResponse,
  boundConnectorTypes: Set<string>,
): AnalyzerViolation[] {
  if (out.triggerConfig?.type !== 'cron') return [];
  if (!hasReactiveKeyword(responsibilities)) return [];

  const available = collectAvailableEventTopics(catalog, boundConnectorTypes);
  if (available.length === 0) return [];

  // The escape applies only to cadences that are genuinely schedules.
  //
  // "Respect a pinned schedule" holds for calendar-shaped work and for
  // connectors that cannot deliver events. It does not hold for a sub-hourly
  // cadence on a reactive role whose connector CAN deliver: there the number is
  // a request for immediacy, and polling on it re-lists and re-decides work the
  // event already reported.
  //
  // The cadence is not discarded — the message below moves it into
  // companionCrons as the catch-up sweep, so it still runs.
  const cadenceIsTheRequirement =
    !hasSubHourlyCronIntent(responsibilities)
    || hasAggregateOutputIntent(responsibilities)
    || hasLiteralCronExpression(responsibilities);
  if (hasExplicitCronIntent(responsibilities) && cadenceIsTheRequirement) return [];

  const hit = firstReactiveMatch(responsibilities) ?? 'reactive verb';
  const offerings = available
    .map((a) => `${a.connectorType} → ${a.topics.join(', ')}`)
    .join('; ');

  return [{
    rule: 'cron_trigger_with_event_topic_available',
    severity: 'reject',
    message:
      `Primary trigger is "cron" but the responsibilities are reactive (matched: "${hit}") ` +
      `and a real event topic is published for at least one bound connector. ` +
      `Event-eligible agents must use type:"event" so they fire on actual arrivals, not poll ` +
      `on a fixed clock. Available topics — ${offerings}. ` +
      `Copy one topic VERBATIM into eventTopic, and list EVERY topic the role handles in ` +
      `eventTopics. Set type:"event" and remove cronExpr from the primary trigger.` +
      (hasSubHourlyCronIntent(responsibilities)
        ? ` The responsibilities do state a fast cadence. Keep it: move that exact cron ` +
          `expression into companionCrons as a catch-up sweep, with a workSource that lists ` +
          `the records to process. A cadence under an hour is a request to react quickly, ` +
          `not a calendar; the event topic is how the platform delivers that, and the sweep ` +
          `is the net underneath it.`
        : ` (If the responsibilities also need a separate periodic sweep, move that into ` +
          `companionCrons.) A cron primary is correct here only when the user pinned a ` +
          `calendar schedule like "daily at 9am" — they did not.`),
    detail: {
      matchedKeyword: hit,
      currentCronExpr: out.triggerConfig?.cronExpr,
      availableTopicsByConnector: available,
      subHourlyCadencePinned: hasSubHourlyCronIntent(responsibilities),
    },
  }];
}

// ── Rule 7: soft_directive_uncheckable ────────────────────────────────────
//
// Plain-language role descriptions are full of SOFT directives the model can
// 80%-comply-with and still claim success ("be responsive", "keep stakeholders
// informed", "respond promptly", "use good judgment") rather than CHECKABLE
// rules — a number, a "never", or a concrete done-condition. Distillation should
// SURFACE these so the author can tighten them into laws. This rule flags the
// produced systemPrompt + userInstructions for the well-known soft-directive
// idioms and NOTHING ELSE.
//
// ── Calibration (why these exact patterns, and why warn-only) ──────────────
// The full agent-templates catalog (~6.5k lines) is this product's gold
// standard of instruction copy. Grepping the candidate idioms across every
// catalog YAML produced only TWO hits, and both are genuine soft directives —
// zero false positives:
//   • sales-development-representative: "respond promptly, answer their
//     question or confirm the meeting…"  → "respond promptly" (uncheckable)
//   • customer-escalation-manager: "…Keep the account executive informed at
//     every stage…"                       → "keep <person> informed" (uncheckable)
// Both sit inside otherwise-checkable, hard-ruled prose. Warn is exactly right:
// they are real soft directives worth surfacing, but must never block a
// distillation (there is nothing structurally invalid about them).
//
// Patterns that were CONSIDERED and DROPPED for precision:
//   • "as needed" / "as appropriate" / "as necessary" — appear in legitimate
//     descriptive conditionals ("looking up PTO balance in the HR system as
//     needed"), not as behavioral directives. High false-positive rate. DROP.
//   • bare "\bpromptly\b" — kept only the anchored imperative form
//     "respond/reply/act/follow up/get back promptly" so descriptive uses
//     ("promptly acknowledged the ticket") don't trip.
//   • "keep X <adjective>" generally — "Keep the documentation current with
//     every release" is CHECKABLE. So the keep-informed pattern is anchored to
//     communication-target NOUNS (stakeholders, the team, management, …), never
//     to arbitrary objects.
//   • "be clear/specific/accurate", "be patient" — dropped: "accurate"/"clear"
//     often describe a checkable outcome, and "patient" is a homograph
//     (healthcare/HRIS "the patient"). Kept only unambiguous quality adjectives.
//
// The result is a curated, high-precision idiom list. It favors false negatives
// (misses a novel soft phrasing) over false positives (never nags good copy).
// Because severity is ALWAYS 'warn', it can never add a blocking violation and
// so can never break the distillation retry loop.

interface SoftDirectivePattern {
  /** Human label for the category, surfaced in the violation detail. */
  label: string;
  re: RegExp;
}

const SOFT_DIRECTIVE_PATTERNS: SoftDirectivePattern[] = [
  // "be <quality-adjective>" — a behavior asserted with no criterion. Only
  // unambiguous quality adjectives; homographs and outcome-words excluded.
  {
    label: 'be <quality-adjective>',
    re: /\bbe (professional|responsive|helpful|proactive|thorough|diligent|courteous|friendly|empathetic|respectful|polite|concise|attentive|collaborative|transparent)\b/gi,
  },
  // "act/remain/stay/behave professional(ly)".
  {
    label: 'act professionally',
    re: /\b(?:act|remain|stay|behave)(?:s|ing)? professional(?:ly)?\b/gi,
  },
  // "respond/reply/act/follow up/get back promptly" — anchored imperative only.
  {
    label: 'respond promptly',
    re: /\b(?:respond|reply|act|follow up|get back)(?:s|ing)? promptly\b/gi,
  },
  // "in a timely manner/fashion".
  {
    label: 'in a timely manner',
    re: /\bin a timely (?:manner|fashion)\b/gi,
  },
  // "use (good/sound/your best/your own) judgment" / "exercise (good) judgment
  // or discretion" — defers the decision instead of stating the rule.
  {
    label: 'use judgment / exercise discretion',
    re: /\b(?:use|using|exercise|exercising|apply|applying) (?:good |sound |your best |your own |appropriate )?(?:judgment|judgement|discretion)\b/gi,
  },
  // "strive/aim/endeavor/seek to …" / "do your best" / "make every effort" —
  // aspiration verbs that name no done-condition.
  {
    label: 'strive/aim/do your best',
    re: /\b(?:strive|aim|endeavor|endeavour|seek)(?:s|ing)? to\b|\bdo your best\b|\bmake every effort\b|\bwhere possible\b|\bwherever possible\b/gi,
  },
  // "keep <communication-target> informed/updated/posted/in the loop/apprised".
  // Anchored to person/stakeholder nouns so "keep the docs updated" is exempt.
  {
    label: 'keep <stakeholder> informed',
    re: /\bkeep (?:everyone|stakeholders?|the team|the customer|the client|customers|clients|management|leadership|them|people|others|colleagues|your manager|the manager|the account executive|the account owner|reps?|users?) (?:informed|updated|posted|in the loop|apprised|abreast)\b/gi,
  },
  // "provide/deliver <superlative> service/support/experience/results".
  {
    label: 'provide excellent service',
    re: /\b(?:provide|deliver|ensure|offer)(?:s|ing)? (?:excellent|exceptional|outstanding|high-quality|high quality|world-class|top-notch|great|superb|the best possible) (?:service|support|experience|results|care|quality)\b/gi,
  },
  // "maintain/uphold/ensure (a) high standard(s)/quality/level of".
  {
    label: 'maintain a high standard',
    re: /\b(?:maintain|uphold|ensure|hold)(?:s|ing)? (?:a )?high (?:standard|standards|quality|level of)\b/gi,
  },
  // "communicate effectively / clearly and effectively / professionally".
  {
    label: 'communicate effectively',
    re: /\bcommunicate(?:s|ing)? (?:effectively|clearly and effectively|professionally|well)\b/gi,
  },
  // "handle <it/them/things/…> appropriately".
  {
    label: 'handle appropriately',
    re: /\bhandle(?:s|ing)? (?:it|them|this|these|things|matters|issues|situations|requests|cases) appropriately\b/gi,
  },
];

/** Max distinct soft phrases surfaced per distillation, so a pathological
 *  prompt can't flood the violation list / metric stream. */
const MAX_SOFT_DIRECTIVE_MATCHES = 12;

/**
 * Rule 7 — soft / uncheckable behavioral directive.
 *
 * Scans the produced systemPrompt + userInstructions (the directive-bearing
 * surfaces) for the curated soft-directive idioms above and emits ONE warn
 * violation listing the distinct matched phrases. Never rejects, never blocks.
 *
 * Emits a single aggregated violation (not one-per-phrase) so the analyzer
 * metric registers "this distillation contained soft directives: yes" once,
 * with the phrase inventory in `detail` for the dashboard / author.
 */
function detectSoftUncheckableDirectives(out: DistillOutput): AnalyzerViolation[] {
  const text = [
    (out as { systemPrompt?: string }).systemPrompt ?? '',
    (out as { userInstructions?: string }).userInstructions ?? '',
  ].join('\n');
  if (!text.trim()) return [];

  // Preserve first-seen order, dedupe case-insensitively on the matched span.
  const seen = new Set<string>();
  const matches: Array<{ phrase: string; category: string }> = [];
  for (const { label, re } of SOFT_DIRECTIVE_PATTERNS) {
    re.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) {
      const phrase = m[0].trim().replace(/\s+/g, ' ');
      const key = phrase.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      matches.push({ phrase, category: label });
      if (matches.length >= MAX_SOFT_DIRECTIVE_MATCHES) break;
    }
    if (matches.length >= MAX_SOFT_DIRECTIVE_MATCHES) break;
  }

  if (matches.length === 0) return [];

  const quoted = matches.map(x => `"${x.phrase}"`).join(', ');
  return [{
    rule: 'soft_directive_uncheckable',
    severity: 'warn',
    message:
      `The produced instructions contain soft, uncheckable behavioral directive(s): ${quoted}. ` +
      'These assert a behavior the agent can 80%-satisfy while still claiming success. ' +
      'Prefer CHECKABLE rules a run can be graded against: a number ("reply within 4 business hours", ' +
      '"at most 3 attempts"), a hard "never/always" tied to a concrete condition, or an explicit ' +
      'done-condition ("until the customer confirms resolution"). Leave the directive only if it is ' +
      'genuinely a tone note; convert it to a law wherever it governs an action.',
    detail: {
      matchedPhrases: matches.map(x => x.phrase),
      categories: [...new Set(matches.map(x => x.category))],
      count: matches.length,
      truncated: matches.length >= MAX_SOFT_DIRECTIVE_MATCHES,
    },
  }];
}

// ── Public API ──────────────────────────────────────────────────────────────

/**
 * Rule 8 — a routine that would disable the team member that runs it (F5).
 *
 * A distilled routine whose objective tells the agent to pause, disable, or
 * delete itself (or its own schedule) is self-defeating at best and, on a
 * schedule, quietly self-disabling: it fires, turns itself off, and the person
 * discovers weeks later that their team member stopped working with no error
 * anywhere.
 *
 * Anchored on COMMAND-SHAPED phrases with an explicit self-reference, not on
 * bossy English. "Pause the campaign", "archive the deal", "delete the draft"
 * are all ordinary work and must not trip this — the object has to be the team
 * member, its schedule, or its triggers.
 *
 * Severity `reject`: the distiller's retry loop rewrites it, which is exactly
 * the behaviour wanted — the intent behind the prose is usually legitimate
 * ("stop reporting once the migration is done") and just needs to be expressed
 * as a condition rather than as self-destruction.
 */
const SELF_LIFECYCLE_PATTERNS: RegExp[] = [
  // "pause yourself", "disable yourself", "delete yourself"
  /\b(pause|stop|disable|deactivate|delete|remove|archive|shut\s*down|turn\s*off)\b[^.?!]{0,40}\byourself\b/i,
  // "...this team member" / "...this agent" / "...this agent"
  /\b(pause|stop|disable|deactivate|delete|remove|archive|shut\s*down|turn\s*off)\b[^.?!]{0,40}\bthis\s+(team\s+member|agent|ai\s+team|assistant)\b/i,
  // "...your schedule" / "...your routine" / "...your cron" / "...your trigger(s)"
  /\b(pause|stop|disable|deactivate|delete|remove|cancel|turn\s*off)\b[^.?!]{0,40}\byour\s+(schedule|routine|cron|trigger|triggers|automation)\b/i,
  // "...your own schedule/triggers"
  /\b(pause|stop|disable|deactivate|delete|remove|cancel|turn\s*off)\b[^.?!]{0,40}\byour\s+own\b[^.?!]{0,20}\b(schedule|routine|cron|trigger|triggers|automation)\b/i,
];

function detectSelfDisablingRoutine(out: DistillOutput): AnalyzerViolation[] {
  const objectives: string[] = [];
  const tc = out.triggerConfig as {
    companionCrons?: Array<{ label?: string; objective?: string }>;
    companionCron?: { objective?: string };
  } | undefined;
  for (const c of tc?.companionCrons ?? []) {
    if (c.objective) objectives.push(c.objective);
  }
  if (tc?.companionCron?.objective) objectives.push(tc.companionCron.objective);

  const offenders = objectives.filter(o => SELF_LIFECYCLE_PATTERNS.some(re => re.test(o)));
  if (offenders.length === 0) return [];

  return [{
    rule: 'self_disabling_routine',
    severity: 'reject',
    message:
      'A scheduled routine instructs the team member to pause, disable, or delete itself or its own ' +
      'schedule. On a schedule this silently switches the team member off with no error anywhere. ' +
      'Express the intent as a CONDITION inside the routine instead ("report only while the migration ' +
      'is open"), or leave the schedule alone and let a person turn it off.',
    detail: { objectives: offenders },
  }];
}

export function analyzeTriggerConfig(
  out: DistillOutput,
  boundConnectorTypes: Set<string>,
  catalog: ConnectorCatalogResponse,
  responsibilities = '',
): AnalyzerViolation[] {
  const byConnector = buildBoundEntitySchemas(catalog, boundConnectorTypes);
  const globalDeclaredFieldNames = collectDeclaredFieldNamesGlobal(byConnector);
  const anchorFieldNames = collectAnchorFieldNames(byConnector);

  const violations: AnalyzerViolation[] = [];
  violations.push(...detectMixedPrimitives(out));
  // Rule 2 is per-connector scoped (uses sub.source.connectorRef directly).
  violations.push(...detectGhostReactiveFields(out, byConnector));
  // Rule 3 uses the global declared-field union because companionCron
  // objectives don't carry a connector reference.
  violations.push(...detectGhostCompanionFields(out, globalDeclaredFieldNames));
  violations.push(...detectNoAgentWithoutScript(out));
  // Rule 4 walks anchor descriptions across every bound connector.
  violations.push(...detectScheduleFollowupOnAnchoredField(out, anchorFieldNames));
  // Rule 5: manual primary trigger + reactive responsibilities = silent break.
  violations.push(...detectManualTriggerWithReactiveResponsibilities(out, responsibilities));
  // Rule 6: cron primary trigger when an event topic is available and the
  // user didn't pin an explicit schedule. Favor event-based wiring.
  violations.push(...detectCronTriggerWithEventTopicAvailable(out, responsibilities, catalog, boundConnectorTypes));
  // Rule 7: soft / uncheckable behavioral directives in the produced
  // instructions. Warn-only (never blocks) — surfaces "laws not tips" gaps.
  violations.push(...detectSoftUncheckableDirectives(out));
  // Rule 8: a routine that would disable the team member running it.
  violations.push(...detectSelfDisablingRoutine(out));
  return violations;
}

/**
 * Distillation produced a structurally invalid triggerConfig and could not
 * be repaired by the retry loop. Thrown by the distill service so callers
 * (TeamBuilder SSE, template creation) can surface a usable error.
 */
export class DistillationStructuralError extends Error {
  readonly violations: AnalyzerViolation[];
  constructor(violations: AnalyzerViolation[]) {
    const summary = violations.map(v => `[${v.rule}] ${v.message}`).join('\n');
    super(`Distillation produced a structurally invalid triggerConfig:\n${summary}`);
    this.name = 'DistillationStructuralError';
    this.violations = violations;
  }
}

/**
 * True iff any violation in the list requires the distillation to be
 * rejected and retried/failed. Warn-only violations do not block.
 */
/**
 * The person stated an exact cadence; the derived trigger set must contain it.
 *
 * Runs beside analyzeTriggerConfig in the same retry loop rather than inside
 * it: the expectations come from the CALLER (the accept worker parses the
 * routine prose deterministically), not from anything this module can see.
 * Minute, hour and day-of-week must agree with some produced cron — primary
 * or companion; day-of-month and month are the distiller's to widen.
 */
export function checkExpectedCadences(
  triggerConfig: unknown,
  expected: Array<{ prose: string; cronExpr: string }> | undefined,
): AnalyzerViolation[] {
  if (!expected || expected.length === 0) return [];

  const trigger = (triggerConfig ?? {}) as {
    cronExpr?: string;
    companionCrons?: Array<{ cronExpr?: string; label?: string }>;
  };
  const produced: string[] = [];
  if (typeof trigger.cronExpr === 'string') produced.push(trigger.cronExpr);
  for (const companion of trigger.companionCrons ?? []) {
    if (typeof companion.cronExpr === 'string') produced.push(companion.cronExpr);
  }

  const violations: AnalyzerViolation[] = [];
  for (const expectation of expected) {
    const hit = produced.some((cron) => cronMatchesExpected(cron, expectation.cronExpr));
    if (!hit) {
      violations.push({
        rule: 'expected_cadence_missing',
        severity: 'reject',
        message:
          `The guidance states an exact cadence — "${expectation.prose}" — which parses to `
          + `cron "${expectation.cronExpr}", but no produced cron (primary or companion) `
          + 'matches its minute, hour and day-of-week. Emit a cron for exactly that '
          + 'cadence, or move the work into the companion that carries it.',
        detail: { expectedCron: expectation.cronExpr, produced },
      });
    }
  }
  return violations;
}

/**
 * The person stopped a routine; the derived trigger set must not contain it.
 *
 * The mirror of checkExpectedCadences, for the case verification cannot see
 * in the guidance: a stopped routine's line is REMOVED from the guidance, so
 * the only trace of it the model receives is the previous trigger set and the
 * prior decision record — both of which still carry the cadence. A model that
 * preserves them re-emits a schedule the person just ended, and nothing in the
 * guidance text contradicts it. The caller states the stopped cadence
 * deterministically (cadence-parse.ts on the removed line); a produced cron
 * matching its minute, hour and day-of-week rejects the distillation into the
 * same retry-with-feedback loop as the structural rules. Entries whose prose
 * states no parseable cadence carry no cronExpr and are skipped here — they
 * still reach the model as prompt text.
 */
export function checkStoppedCadences(
  triggerConfig: unknown,
  stopped: Array<{ prose: string; cronExpr?: string }> | undefined,
): AnalyzerViolation[] {
  if (!stopped || stopped.length === 0) return [];

  const trigger = (triggerConfig ?? {}) as {
    cronExpr?: string;
    companionCrons?: Array<{ cronExpr?: string; label?: string }>;
  };
  const produced: string[] = [];
  if (typeof trigger.cronExpr === 'string') produced.push(trigger.cronExpr);
  for (const companion of trigger.companionCrons ?? []) {
    if (typeof companion.cronExpr === 'string') produced.push(companion.cronExpr);
  }

  const violations: AnalyzerViolation[] = [];
  for (const entry of stopped) {
    if (!entry.cronExpr) continue;
    const hit = produced.some((cron) => cronMatchesExpected(cron, entry.cronExpr!));
    if (hit) {
      violations.push({
        rule: 'stopped_cadence_present',
        severity: 'reject',
        message:
          `The routine stated by "${entry.prose}" has been STOPPED, but a produced cron `
          + `(primary or companion) still matches its minute, hour and day-of-week `
          + `("${entry.cronExpr}"). Remove that cron and the companion that carried it; `
          + 'do not keep it for label stability or continuity with the previous trigger set.',
        detail: { stoppedCron: entry.cronExpr, produced },
      });
    }
  }
  return violations;
}

export function hasBlockingViolations(violations: AnalyzerViolation[]): boolean {
  return violations.some(v => v.severity === 'reject');
}

/**
 * Format violations into the feedback string handed back to the LLM on
 * retry. The wording asks the LLM to fix the specific structural issue
 * without dictating the new shape — the prompt teaching already covers
 * the right shape.
 */
export function formatViolationsForRetry(violations: AnalyzerViolation[]): string {
  return [
    'Your previous tool call produced a triggerConfig that fails structural validation:',
    ...violations.map(v => `- [${v.rule}] (${v.severity}) ${v.message}`),
    '',
    'Re-emit the same tool call with the same intent, but fix the structural issue(s).',
    'Do not invent new connector capabilities. If a predicate cannot be expressed against a ' +
    'real published field, restate the requirement using companionCrons + on-tool-call logic ' +
    'instead, or use source.kind="computed_metric" with an explicit fn for derived signals.',
  ].join('\n');
}

/**
 * Compute the set of bound connector *types* (e.g. "hubspot", "google_calendar")
 * from the IntegrationInfo[] handed to distill. Distillation's `integrations`
 * carry one integration per user-selected connection; we deduplicate to the
 * underlying connector type for catalog lookup.
 */
export function boundConnectorTypesFromIntegrations(
  integrations: Array<{ type: string }>,
): Set<string> {
  return new Set(integrations.map(i => i.type));
}

/**
 * Helper for consumers that wrap a ConnectorDef[] (e.g. distill-service's
 * `connectorCatalog` is the array shape from getConnectorCatalog()).
 */
export function asCatalogResponse(connectors: ConnectorDef[]): ConnectorCatalogResponse {
  // categoryLabels/version are unused by the analyzer — supply empty defaults
  // so callers can pass the bare connectors array without rebuilding the
  // full response wrapper.
  return {
    connectors,
    version: '',
    categoryLabels: {} as ConnectorCatalogResponse['categoryLabels'],
  };
}
