// What of a Stagehand step is kept for the record, per tool.
//
// The loop records each action as `{ type: toolName, reasoning, pageUrl,
// ...toolArgs }`, so what a step contains depends on the tool: `act` has an
// `action` phrase and, when it succeeded, a structured `playwrightArguments`;
// `fillForm` has `fields[{action, value}]`; `goto` has `url`; `extract` has
// `instruction`. The record keeps the useful phrase AND the value the step
// entered, because an agent that mirrors the workflow needs the search
// term, the filter, the record name; it leaves out only what the protected
// data policy names:
//
//   act        by SHAPE: `method · description · "<value>"` for the
//              value-bearing methods (fill, type, selectOptionFromDropdown);
//              `method · description · <key>` for press, which is a key
//              action rather than entered text; `method · description` for
//              the rest. The value is CLASSIFIED before it is kept, from the
//              description and the ORIGINAL page URL (before URL redaction):
//              a sign-in page omits every value on it, a payment or identity
//              description omits its own. A failed act has no structured
//              shape; its phrase is kept after the protected-literal pass
//   fillForm   each field's action beside its value, grouped with every
//              other value-bearing step on the same original page in two
//              passes: an authentication field protects every value in the
//              fillForm and every sibling value-bearing act on that page;
//              payment and high-risk identity protect only the matching
//              fields, so a billing address survives beside an omitted card
//              number. An omitted field loses its exact structured value
//              from the phrase too and carries its class
//   goto       the safe destination URL (recordedUrl)
//   extract    the instruction, bounded
//   navback, scroll, wait, screenshot, ariaTree, close
//              the operation name plus a short non-content status where the
//              tool has one (a direction, a duration)
//   anything else
//              the bounded tool type and an empty action, until its argument
//              shape has been reviewed
//
// This projection is the FALLBACK for a step the call-scoped DOM observation
// (takeover-capture's TaskCapture) missed: the DOM is the authority for
// state-changing behaviour and entered values, because it can inspect the
// actual containing form before reading a value; this reads only prose and
// a URL. `reasoning` is never copied. `sanitizeStagehandOutcome` collects
// the structured protected literals and removes exact occurrences from the
// closing message and every projected text before any of it is returned,
// logged or persisted, and the credential redactor runs last over the
// message. Each step reports its own truncation and omission, so a partial
// or redacted trail is never presented as exact. `step-policy.test.ts` pins
// the projection and its limits.

import { recordedUrl, sanitizeBrowserText, redactSensitiveText } from '@liftoffos/redact';
import { classifyProtectedControl, type ProtectedControlClass } from '../../browser-sessions/takeover-capture/protected-control';

/** One step as it crosses the wire and lands in the record. */
export interface BrowserTaskStep {
  type: string;
  action: string;
  pageUrl: string;
  actionTruncated: boolean;
  pageUrlTruncated: boolean;
  /** A value this step entered was omitted by the protected data policy. */
  protectedDataOmitted: boolean;
  /** The omitted class when protectedDataOmitted; '' otherwise. */
  protectedKind: string;
  pageUrlProtectedDataOmitted: boolean;
  /** When the step happened; null when the loop did not report a time. */
  at: Date | null;
}

/** The closed, product-safe vocabulary of a task trail's capture gap. */
export type TrailGapReason = 'attach_failed' | 'frame_unavailable' | 'disconnected' | 'cap' | 'reconciliation_uncertain';

/** The loop's steps for the record, beside its closing message. */
export interface BrowserTaskTrail {
  message: string;
  steps: BrowserTaskStep[];
  captureGap: boolean;
  gapReason: TrailGapReason | null;
  stepsTruncated: boolean;
}

export const STEP_TYPE_CAP = 64;
export const STEP_ACTION_CAP = 2000;

/** The shape Stagehand hands back per action; everything but `type` is the
 *  tool's own arguments and may be absent. */
export interface StagehandActionLike {
  type: string;
  action?: unknown;
  pageUrl?: unknown;
  url?: unknown;
  instruction?: unknown;
  fields?: unknown;
  direction?: unknown;
  timeMs?: unknown;
  /** Stagehand's ObserveResult for a successful act: `{ description, method,
   *  arguments, selector }`. `arguments[0]` is the value for a value-bearing
   *  method and the key for press. */
  playwrightArguments?: unknown;
  [key: string]: unknown;
}

/** Stagehand 2.5.9's value-bearing act methods. */
const VALUE_METHODS: Record<string, true> = { fill: true, type: true, selectOptionFromDropdown: true };

interface ActShape {
  method: string;
  description: string;
  value: string | null;
  key: string | null;
}

function actShape(raw: unknown): ActShape | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const pa = raw as { method?: unknown; description?: unknown; arguments?: unknown };
  const method = typeof pa.method === 'string' ? pa.method.replace(/\s+/g, ' ').trim() : '';
  const description = typeof pa.description === 'string' ? pa.description.replace(/\s+/g, ' ').trim() : '';
  if (!method && !description) return null;
  const args = Array.isArray(pa.arguments) ? pa.arguments : [];
  const first = typeof args[0] === 'string' ? args[0] : null;
  return {
    method,
    description,
    value: VALUE_METHODS[method] && first !== null ? first : null,
    key: method === 'press' && first !== null ? first : null,
  };
}

function bounded(value: unknown, cap: number): { text: string; truncated: boolean } {
  const whole = typeof value === 'string' ? value.replace(/\s+/g, ' ').trim() : '';
  return { text: whole.slice(0, cap), truncated: whole.length > cap };
}

function classOf(description: string, originalUrl: unknown): ProtectedControlClass {
  return classifyProtectedControl({
    description,
    url: typeof originalUrl === 'string' ? originalUrl : '',
  });
}

/** Shortest protected literal removed from OTHER texts. A one- or two-
 *  character value is omitted from its own step regardless, but hunting it
 *  across every phrase would cut ordinary text apart ("12" inside "2012"). */
const LITERAL_MIN_LENGTH = 3;

/** Remove every exact occurrence of the protected literals from a text.
 *  Longest first so a literal that contains another is removed whole. */
function withoutLiterals(text: string, literals: ReadonlySet<string>): { text: string; changed: boolean } {
  let out = text;
  let changed = false;
  for (const literal of [...literals].sort((a, b) => b.length - a.length)) {
    if (literal.length < LITERAL_MIN_LENGTH || !out.includes(literal)) continue;
    out = out.split(literal).join('[redacted]');
    changed = true;
  }
  return { text: out, changed };
}

/** The per-page classification of every value-bearing step, in two passes:
 *  first each value's own class, then the page-wide authentication rule. */
interface ValueBearing {
  index: number;
  /** For a fillForm, the field's position. */
  field: number | null;
  ownClass: ProtectedControlClass;
  page: string;
}

function valueBearingSteps(actions: ReadonlyArray<StagehandActionLike>): ValueBearing[] {
  const out: ValueBearing[] = [];
  actions.forEach((action, index) => {
    const page = typeof action.pageUrl === 'string' ? action.pageUrl : '';
    if (action.type === 'act') {
      const shape = actShape(action.playwrightArguments);
      if (shape?.value !== null && shape?.value !== undefined) {
        out.push({ index, field: null, ownClass: classOf(shape.description, page), page });
      }
    } else if (action.type === 'fillForm') {
      const fields = Array.isArray(action.fields) ? action.fields : [];
      fields.forEach((f, i) => {
        const field = f as { action?: unknown; value?: unknown };
        if (typeof field?.value !== 'string') return;
        const description = typeof field.action === 'string' ? field.action : '';
        out.push({ index, field: i, ownClass: classOf(description, page), page });
      });
    }
  });
  // Second pass: a page with any authentication value protects every value
  // on it, payment and identity protect only their own.
  const authPages = new Set(out.filter((v) => v.ownClass === 'authentication').map((v) => v.page));
  return out.map((v) => (authPages.has(v.page) ? { ...v, ownClass: 'authentication' } : v));
}

function kindKey(index: number, field: number | null): string {
  return `${index}:${field === null ? '' : field}`;
}

export interface ProjectedTrail {
  steps: BrowserTaskStep[];
  /** Every structured value the policy omitted, for the outcome pass. */
  protectedLiterals: Set<string>;
}

/** Project every action, in order, applying the two-pass grouping. */
export function projectStagehandSteps(actions: ReadonlyArray<StagehandActionLike>): ProjectedTrail {
  const classes = new Map<string, ProtectedControlClass>();
  for (const v of valueBearingSteps(actions)) classes.set(kindKey(v.index, v.field), v.ownClass);
  const protectedLiterals = new Set<string>();

  const steps = actions.map((action, index): BrowserTaskStep => {
    const type = bounded(action.type, STEP_TYPE_CAP).text;
    const page = recordedUrl(typeof action.pageUrl === 'string' ? action.pageUrl : '');
    let text = '';
    let protectedKind = '';
    let omitted = false;
    switch (action.type) {
      case 'act': {
        const shape = actShape(action.playwrightArguments);
        if (shape) {
          const parts = [shape.method, shape.description].filter((p) => p.length > 0);
          if (shape.value !== null) {
            const cls = classes.get(kindKey(index, null)) ?? '';
            if (cls) {
              protectedLiterals.add(shape.value);
              parts.push(`(${cls} value not recorded)`);
              protectedKind = cls;
              omitted = true;
            } else {
              parts.push(JSON.stringify(shape.value));
            }
          } else if (shape.key !== null) {
            parts.push(shape.key);
          }
          text = parts.join(' · ');
        } else {
          // A failed act has no structured shape: the phrase, with any
          // literal the policy already named removed.
          text = typeof action.action === 'string' ? action.action : '';
        }
        break;
      }
      case 'fillForm': {
        const fields = Array.isArray(action.fields) ? action.fields : [];
        text = fields
          .map((f, i) => {
            const field = f as { action?: unknown; value?: unknown };
            const phrase = typeof field?.action === 'string' ? field.action.replace(/\s+/g, ' ').trim() : '';
            if (typeof field?.value !== 'string') return phrase;
            const cls = classes.get(kindKey(index, i)) ?? '';
            if (cls) {
              protectedLiterals.add(field.value);
              omitted = true;
              if (!protectedKind) protectedKind = cls;
              // The exact structured value goes from the phrase too.
              const cleaned = field.value ? phrase.split(field.value).join('[redacted]') : phrase;
              return `${cleaned} (${cls} value not recorded)`;
            }
            return `${phrase} ${JSON.stringify(field.value)}`;
          })
          .filter((s) => s.length > 0)
          .join('; ');
        break;
      }
      case 'goto': {
        const dest = recordedUrl(typeof action.url === 'string' ? action.url : '');
        text = dest.text;
        if (dest.protectedDataOmitted) omitted = true;
        break;
      }
      case 'extract':
        text = typeof action.instruction === 'string' ? action.instruction : '';
        break;
      case 'scroll':
        text = typeof action.direction === 'string' ? `scroll ${bounded(action.direction, 16).text}` : 'scroll';
        break;
      case 'wait':
        text = typeof action.timeMs === 'number' && Number.isFinite(action.timeMs)
          ? `wait ${Math.round(action.timeMs)}ms`
          : 'wait';
        break;
      case 'navback':
      case 'screenshot':
      case 'ariaTree':
      case 'close':
        text = action.type;
        break;
      default:
        // An unreviewed tool: its arguments are not copied until they have been.
        text = '';
    }
    const action_ = bounded(text, STEP_ACTION_CAP);
    return {
      type,
      action: action_.text,
      pageUrl: page.text,
      actionTruncated: action_.truncated,
      pageUrlTruncated: page.truncated,
      protectedDataOmitted: omitted,
      protectedKind,
      pageUrlProtectedDataOmitted: page.protectedDataOmitted,
      at: null,
    };
  });

  // The literal pass over every projected text: a failed act's phrase, an
  // extract instruction or a description can quote a value the policy named.
  for (const step of steps) {
    const cleaned = withoutLiterals(step.action, protectedLiterals);
    if (cleaned.changed) {
      step.action = cleaned.text;
      step.protectedDataOmitted = true;
      if (!step.protectedKind) step.protectedKind = 'sensitive_text';
    }
    const safe = sanitizeBrowserText(step.action, STEP_ACTION_CAP);
    if (safe.protectedDataOmitted) {
      step.action = safe.text;
      step.protectedDataOmitted = true;
      if (!step.protectedKind) step.protectedKind = 'sensitive_text';
    }
  }
  return { steps, protectedLiterals };
}

/** The closing message and any other outcome text, with every protected
 *  literal removed and the credential redactor applied last. The same text
 *  is used everywhere the outcome appears: `result.message`, top-level
 *  `data`, the trail and the activity outcome. */
export function sanitizeStagehandOutcome(
  message: unknown,
  protectedLiterals: ReadonlySet<string>,
): { text: string; truncated: boolean; protectedDataOmitted: boolean } {
  const raw = typeof message === 'string' ? message : '';
  const cleaned = withoutLiterals(raw, protectedLiterals);
  const safe = sanitizeBrowserText(cleaned.text);
  const final = redactSensitiveText(safe.text);
  return {
    text: final,
    truncated: safe.truncated,
    protectedDataOmitted: cleaned.changed || safe.protectedDataOmitted || final !== safe.text,
  };
}

/** Project every action, in order, into the trail the record keeps. The
 *  completeness fields are the caller's to set from its capture. */
export function projectStagehandTrail(
  actions: ReadonlyArray<StagehandActionLike>,
  message: unknown,
): BrowserTaskTrail & { protectedLiterals: Set<string> } {
  const projected = projectStagehandSteps(actions);
  const outcome = sanitizeStagehandOutcome(message, projected.protectedLiterals);
  return {
    message: outcome.text,
    steps: projected.steps,
    captureGap: false,
    gapReason: null,
    stepsTruncated: false,
    protectedLiterals: projected.protectedLiterals,
  };
}
