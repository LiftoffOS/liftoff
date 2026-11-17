// The salvage turn: a read-only step interrupted after doing work finishes
// from what it has.
//
// A step's tool calls are its work. When the model turn that issued them is
// cut off — the step's anomaly handler aborted it, the engine errored, the
// turn ended without recording the declared output — everything those calls
// returned died with the turn, the retries started from nothing, and every
// later step never ran. The salvage turn is one more model turn on the SAME
// step, handed the material its tools already returned and nothing else, asked
// to produce the step's declared output from that material alone. The graph
// then advances through `onSuccess` and the team's own delivery steps take it
// from there: nothing new decides where output goes.
//
// Two things this module holds to:
//
//   1. The digest is FAIR-SHARE and DETERMINISTIC. Every successful call gets
//      an equal share of the budget, so early, middle and late results all
//      appear; a call that needs less than its share hands the surplus back in
//      one second pass. Order is preserved. Equal inputs give byte-equal text.
//
//   2. The prompt does NOT ask the model to put a shortfall inside the output.
//      A declared `outputField` may be a scalar or a schema with no such member.
//      The shortfall travels as trusted metadata (`SalvageNote`) to the steps
//      that read this one's output, rendered by earlier-outputs-view.ts.

import { redactUrl } from '../../integrations/web-fetch/url-redactor';
import type { WorkflowStep } from '../types';
import { canonicalJson } from '../sideeffect-idempotency';

/** Why the step's turn ended before the step did. The metric label and the
 *  note's `interruptedBy`. */
export type SalvageCause = 'anomaly_escalated' | 'engine_error' | 'output_shape_mismatch';

/** What a later step is told about a salvaged output: which of the step's
 *  calls did not return, so anything that depended on them is unknown. */
export interface SalvageNote {
  unavailable: Array<{ name: string; args: string }>;
  interruptedBy: SalvageCause;
}

/** One of the step's tool calls, as the loop records it. */
export interface SalvageDigestCall {
  name?: string;
  input?: unknown;
  success: boolean;
  result?: unknown;
  error?: string;
  errorCode?: string;
}

export interface SalvageDigest {
  text: string;
  successes: number;
  failures: number;
  /** The failed calls, name and bounded arguments, for the note. */
  unavailable: Array<{ name: string; args: string }>;
}

/** The whole digest, header and labels included. */
const SALVAGE_DIGEST_BUDGET = 16_000;
/** No single call's output takes more than this, whatever its share. */
const SALVAGE_PER_CALL_CAP = 2_000;
/** Arguments are a label, not material. */
const ARGS_MAX_CHARS = 200;

/** Argument keys whose values never leave the process in a prompt. The URL
 *  redactor covers query strings; this covers the bare fields. */
const SECRET_ARG_KEYS = new Set([
  'token', 'access_token', 'refresh_token', 'id_token', 'api_key', 'apikey',
  'key', 'password', 'pwd', 'pass', 'secret', 'auth', 'authorization',
  'cookie', 'cookies', 'session', 'sid', 'jwt', 'credential', 'credentials',
]);

function redactValue(value: unknown, depth = 0): unknown {
  if (depth > 6) return '[…]';
  if (typeof value === 'string') {
    return /^https?:\/\//i.test(value) ? redactUrl(value) : value;
  }
  if (Array.isArray(value)) return value.map((v) => redactValue(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = SECRET_ARG_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redactValue(v, depth + 1);
    }
    return out;
  }
  return value;
}

/** `canonicalJson` of the arguments with URLs and secret fields redacted,
 *  bounded to ARGS_MAX_CHARS. Canonical so equal arguments give equal text. */
function boundedArgs(input: unknown): string {
  let text: string;
  try {
    text = canonicalJson(redactValue(input ?? {}));
  } catch {
    text = '{}';
  }
  return text.length > ARGS_MAX_CHARS ? `${text.slice(0, ARGS_MAX_CHARS - 1)}…` : text;
}

function serializeResult(result: unknown): string {
  if (result === undefined) return '(no result)';
  if (typeof result === 'string') return result;
  try {
    return JSON.stringify(result) ?? String(result);
  } catch {
    return String(result);
  }
}

function truncationSuffix(kept: number, total: number): string {
  return `…[truncated, ${kept} of ${total} chars]`;
}

/** Cut `text` to at most `allot` characters INCLUDING the suffix that says so. */
function boundOutput(text: string, allot: number): string {
  if (text.length <= allot) return text;
  const keep = Math.max(0, allot - truncationSuffix(allot, text.length).length);
  return `${text.slice(0, keep)}${truncationSuffix(keep, text.length)}`;
}

/** A call's label: `name(args)`. */
function labelFor(call: SalvageDigestCall): string {
  const name = call.name && call.name.trim() ? call.name : 'unknown_tool';
  return `${name}(${boundedArgs(call.input)})`;
}

/**
 * The material the salvage turn is given: every successful call's output under
 * a fair share of the budget, every failed call as a one-line fact.
 *
 * Fair share: after the header, the labels of every successful call and the
 * failed-call lines are reserved, the remainder is divided equally across the
 * successful calls, each capped at SALVAGE_PER_CALL_CAP. A call whose output is
 * under its share returns the surplus to the pool, and ONE second pass divides
 * that surplus equally among the calls that were cut. Order is preserved
 * throughout, so early, middle and late results all appear.
 */
export function buildStepSalvageDigest(calls: readonly SalvageDigestCall[]): SalvageDigest {
  const successes = calls.filter((c) => c.success);
  const failures = calls.filter((c) => !c.success);
  const header = `Tool calls this step made: ${calls.length} (${successes.length} succeeded, ${failures.length} failed).`;
  const labels = successes.map(labelFor);
  const failedLines = failures.map((c) => `${labelFor(c)}: ${c.errorCode && c.errorCode.trim() ? c.errorCode : 'failed'}`);
  const unavailable = failures.map((c) => ({
    name: c.name && c.name.trim() ? c.name : 'unknown_tool',
    args: boundedArgs(c.input),
  }));

  // Reserved: the header, one line per label (plus its ": " and newline), and
  // the failed-call section.
  let reserved = header.length + 1;
  for (const l of labels) reserved += l.length + 3;
  if (failedLines.length > 0) {
    reserved += 'Calls that did not return:'.length + 1;
    for (const l of failedLines) reserved += l.length + 1;
  }
  const pool = Math.max(0, SALVAGE_DIGEST_BUDGET - reserved);

  const outputs = successes.map((c) => serializeResult(c.result));
  const n = successes.length;
  const allot = new Array<number>(n).fill(0);
  if (n > 0) {
    // First pass: an equal share, capped. Surplus from calls under their share
    // returns to the pool.
    const share = Math.min(SALVAGE_PER_CALL_CAP, Math.floor(pool / n));
    let surplus = 0;
    const cut: number[] = [];
    for (let i = 0; i < n; i++) {
      if (outputs[i].length <= share) {
        allot[i] = outputs[i].length;
        surplus += share - outputs[i].length;
      } else {
        allot[i] = share;
        cut.push(i);
      }
    }
    // Second pass, once: the surplus divided equally among the cut calls,
    // still under the per-call cap. What the cap refuses is not redistributed
    // again.
    if (cut.length > 0 && surplus > 0) {
      const extra = Math.floor(surplus / cut.length);
      for (const i of cut) {
        allot[i] = Math.min(SALVAGE_PER_CALL_CAP, allot[i] + extra, outputs[i].length);
      }
    }
  }

  const lines: string[] = [header];
  for (let i = 0; i < n; i++) {
    lines.push(`${labels[i]}: ${boundOutput(outputs[i], allot[i])}`);
  }
  if (failedLines.length > 0) {
    lines.push('Calls that did not return:');
    for (const l of failedLines) lines.push(l);
  }
  return { text: lines.join('\n'), successes: n, failures: failures.length, unavailable };
}

/**
 * The salvage turn's instruction. Byte-stable for equal inputs.
 *
 * The step's own description is carried verbatim: it is the step's goal and
 * its output instructions, and the salvage turn is bound by both. What is
 * added says only that the step was interrupted, that the material below is
 * what its tools returned, and that the turn is to finish from that material
 * alone — nothing may be called or fetched, and nothing may be guessed at.
 */
export function buildStepSalvagePrompt(step: WorkflowStep, digest: SalvageDigest): string {
  return [
    step.description,
    '',
    'This step was interrupted before it finished. What its tools returned before the',
    'interruption is below. Finish the step from this material only: call nothing and',
    'fetch nothing. Where the material is missing or was cut short, do not guess at what',
    'it would have said; work only from what is present. Follow this step\'s own output',
    'instructions above for what to produce and how.',
    '',
    'Material this step already gathered:',
    digest.text,
  ].join('\n');
}

/** The one line a later step is shown under a salvaged output. Code-authored,
 *  trusted, and the only way the shortfall travels: the output itself carries
 *  no marker, because a declared outputField may have no room for one. */
export function salvageNoteLine(stepId: string, note: SalvageNote): string {
  const calls = note.unavailable.length === 0
    ? 'none recorded'
    : note.unavailable.map((u) => `${u.name}(${u.args})`).join('; ');
  return `[${stepId}: produced from partial material — these calls did not return: ${calls}; `
    + 'treat anything that depended on them as unknown, not empty]';
}
