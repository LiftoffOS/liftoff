// The trail of a turn: what the Chief AI Officer did, kept beside what it said.
//
// The execution loop gathers every tool call of a turn with its input and
// output. Written down whole, that would be a copy of every page it read and
// every payload a vendor returned; the trail exists to answer "what was done,
// with what, and did it work" when the person later asks for the work to be
// automated, so each entry is bounded and redacted before it is stored, and a
// turn keeps at most the first MAX_ENTRIES calls. A turn that exceeded the
// cap ends with one `record_gap` sentinel naming the omitted count: the
// record says what it does not hold rather than presenting a partial trail
// as complete.
//
// A browser task's result carries the loop's own steps beside its message
// (platform-backend's assistant-browser endpoint returns both). The entry
// keeps the message alone as its outcome and the steps as their own list, at
// most MAX_STEPS, each field bounded and redacted, with the runtime's
// completeness fields (`captureGap`, `gapReason`, `stepsTruncated`)
// preserved. If this final redaction pass changes a step's action or URL,
// its protected-omission flag is upgraded rather than the step silently
// altered. For a browser entry the persisted `input.prompt` / `input.url` is
// the SAFE instruction the endpoint returned, with its explicit omission and
// truncation markers, never the raw tool argument: the raw argument is not
// the durable work record.

import { redactSensitiveText } from '@liftoffos/redact';
import type { ToolTrailEntry, ToolTrailStep } from './chat-repository.js';

export const MAX_ENTRIES = 40;
export const MAX_STEPS = 60;
const MAX_INPUT_CHARS = 1_500;
const MAX_OUTCOME_CHARS = 600;
const MAX_STEP_TYPE_CHARS = 64;
const MAX_STEP_ACTION_CHARS = 2_000;
const MAX_STEP_URL_CHARS = 2_048;
const MAX_GAP_REASON_CHARS = 400;

/** The tool name of the sentinel a capped turn ends with. */
export const RECORD_GAP_TOOL = 'record_gap';
/** Its closed gap reason. */
export const TOOL_CALL_CAP_REASON = 'tool_call_cap';

/** The explicit markers a safe instruction carries inside the input. */
export const PROTECTED_DATA_OMITTED_MARKER = '[protected data omitted]';
export const TRUNCATED_MARKER = '[truncated]';

/** The keys a browser tool's raw argument travels under. */
const BROWSER_INSTRUCTION_KEYS = ['prompt', 'url'] as const;

interface BrowserResultLike {
  message: string;
  steps?: unknown;
  stepsTruncated?: unknown;
  captureGap?: unknown;
  gapReason?: unknown;
  safeInstruction?: unknown;
  instructionTruncated?: unknown;
  instructionProtectedDataOmitted?: unknown;
}

function isBrowserResult(output: unknown): output is BrowserResultLike {
  return typeof output === 'object' && output !== null && typeof (output as { message?: unknown }).message === 'string';
}

export function buildToolTrail(
  toolCalls: ReadonlyArray<{ name: string; input: Record<string, unknown>; output: unknown }>,
): ToolTrailEntry[] {
  const kept = toolCalls.slice(0, MAX_ENTRIES).map(entryFor);
  if (toolCalls.length > MAX_ENTRIES) {
    const omitted = toolCalls.length - MAX_ENTRIES;
    kept.push({
      tool: RECORD_GAP_TOOL,
      input: { omitted },
      outcome: `${omitted} later tool call${omitted === 1 ? '' : 's'} of this turn ${omitted === 1 ? 'is' : 'are'} not in the record`,
      captureGap: true,
      gapReason: TOOL_CALL_CAP_REASON,
    });
  }
  return kept;
}

function entryFor(call: { name: string; input: Record<string, unknown>; output: unknown }): ToolTrailEntry {
  const browser = isBrowserResult(call.output) ? call.output : null;
  const hasSteps = browser !== null && Array.isArray(browser.steps);

  // A browser entry's persisted instruction is the endpoint's safe one.
  let input = call.input;
  let inputTruncated = false;
  let inputProtectedDataOmitted = false;
  if (browser && typeof browser.safeInstruction === 'string') {
    const key = BROWSER_INSTRUCTION_KEYS.find((k) => typeof call.input[k] === 'string');
    if (key) {
      const markers = [
        ...(browser.instructionProtectedDataOmitted === true ? [PROTECTED_DATA_OMITTED_MARKER] : []),
        ...(browser.instructionTruncated === true ? [TRUNCATED_MARKER] : []),
      ];
      input = { ...call.input, [key]: markers.length ? `${browser.safeInstruction} ${markers.join(' ')}` : browser.safeInstruction };
      inputTruncated = browser.instructionTruncated === true;
      inputProtectedDataOmitted = browser.instructionProtectedDataOmitted === true;
    }
  }
  const bounded = boundedInput(input);
  if (bounded.changed) inputProtectedDataOmitted = true;
  if (bounded.omitted) inputTruncated = true;

  const outcome = hasSteps
    ? boundedText(browser.message, MAX_OUTCOME_CHARS)
    : boundedText(call.output, MAX_OUTCOME_CHARS);

  const entry: ToolTrailEntry = {
    tool: call.name,
    input: bounded.value,
    outcome: outcome.text,
    ...(inputTruncated ? { inputTruncated: true } : {}),
    ...(inputProtectedDataOmitted ? { inputProtectedDataOmitted: true } : {}),
    ...(outcome.truncated ? { outcomeTruncated: true } : {}),
    ...(outcome.changed ? { outcomeProtectedDataOmitted: true } : {}),
  };
  if (hasSteps) {
    const raw = browser.steps as unknown[];
    entry.steps = raw.slice(0, MAX_STEPS).map(stepFor);
    const truncated = raw.length > MAX_STEPS || browser.stepsTruncated === true;
    if (truncated) entry.stepsTruncated = true;
    if (browser.captureGap === true) {
      entry.captureGap = true;
      entry.gapReason = typeof browser.gapReason === 'string' ? browser.gapReason.slice(0, MAX_GAP_REASON_CHARS) : '';
    }
  }
  return entry;
}

/** One step, every field bounded and redacted; a redaction that changes the
 *  action or URL upgrades the matching omission flag. */
function stepFor(raw: unknown): ToolTrailStep {
  const s = (typeof raw === 'object' && raw !== null ? raw : {}) as Record<string, unknown>;
  const type = boundedText(s.type, MAX_STEP_TYPE_CHARS);
  const action = boundedText(s.action, MAX_STEP_ACTION_CHARS);
  const pageUrl = boundedText(s.pageUrl, MAX_STEP_URL_CHARS);
  return {
    type: type.text,
    action: action.text,
    pageUrl: pageUrl.text,
    actionTruncated: s.actionTruncated === true || action.truncated,
    pageUrlTruncated: s.pageUrlTruncated === true || pageUrl.truncated,
    protectedDataOmitted: s.protectedDataOmitted === true || action.changed,
    protectedKind: typeof s.protectedKind === 'string' && s.protectedKind
      ? s.protectedKind.slice(0, 32)
      : (action.changed ? 'sensitive_text' : ''),
    pageUrlProtectedDataOmitted: s.pageUrlProtectedDataOmitted === true || pageUrl.changed,
    at: typeof s.at === 'string' && s.at ? s.at.slice(0, 40) : null,
  };
}

/** The input with every string value redacted and the whole kept under the
 *  size bound; an input too large to keep is replaced by a note saying so,
 *  never truncated mid-JSON into something that is not JSON. */
function boundedInput(input: Record<string, unknown>): { value: Record<string, unknown>; changed: boolean; omitted: boolean } {
  const redacted = redactValue(input) as Record<string, unknown>;
  const changed = JSON.stringify(redacted) !== JSON.stringify(input);
  const serialized = JSON.stringify(redacted);
  if (serialized.length <= MAX_INPUT_CHARS) return { value: redacted, changed, omitted: false };
  const keys = Object.keys(input);
  return { value: { _omitted: `input of ${serialized.length} characters not kept`, keys }, changed, omitted: true };
}

function redactValue(value: unknown): unknown {
  if (typeof value === 'string') return redactSensitiveText(value);
  if (Array.isArray(value)) return value.map(redactValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) out[k] = redactValue(v);
    return out;
  }
  return value;
}

function boundedText(output: unknown, max: number): { text: string; truncated: boolean; changed: boolean } {
  const text = typeof output === 'string' ? output : output == null ? '' : safeJson(output);
  const redacted = redactSensitiveText(text);
  const changed = redacted !== text;
  if (redacted.length <= max) return { text: redacted, truncated: false, changed };
  return { text: `${redacted.slice(0, max)}…`, truncated: true, changed };
}

function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return String(value);
  }
}
