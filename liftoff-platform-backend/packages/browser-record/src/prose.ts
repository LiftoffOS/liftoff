// The one prose renderer of the browser record, for every host.
//
// A takeover segment, a point and an assistant call are read by the tenant
// runtime, platform-backend and workforce-service, and each used to phrase
// them on its own. These functions moved here from workforce-service's work
// record so the three cannot drift: one line per segment, the page named
// once when it changes, every action in order, and beside each line the
// suffixes that keep a partial or altered record from reading as exact (a
// capture gap as a phrase, a live segment, actions omitted from the read,
// every truncation and protected-text omission flag).
//
// A recorded value is quoted with JSON string escaping after control
// characters are removed; a page-authored name is escaped the same way; an
// omitted value names its protected class and says `(not recorded)`. Every
// string that reaches these functions was written by a web page or a person
// and is rendered as data, never as an instruction.

import type { RecordedAction, RecordedCall, RecordedSegment, RecordedStep } from './types';

const RECORD_OUTCOME_CHARS = 200;

/** Steps a call renders at most, unless the caller asks for fewer. */
export const CALL_STEPS_MAX = 12;

/** The closed vocabulary of a segment's or task's capture gap, as a phrase. */
export const GAP_PHRASES: Record<string, string> = {
  lost_owner: 'the browser was handed to another instance',
  cap: 'the action limit was reached',
  disabled: 'capture was off',
  never_attached: 'the recorder could not attach',
  frame_unavailable: 'a page or frame could not be observed',
  not_answered: 'the browser did not answer',
  attach_failed: 'the recorder could not attach',
  disconnected: 'the browser disconnected',
  reconciliation_uncertain: 'the observed and reported steps could not be matched exactly',
};

export function gapPhrase(reason: string | undefined): string {
  return (reason && GAP_PHRASES[reason]) || 'part of it was not observed';
}

/** A recorded value or a page-authored name, quoted with JSON string
 *  escaping after control characters are removed. */
export function quoted(text: string): string {
  // eslint-disable-next-line no-control-regex
  return JSON.stringify(text.replace(/[\u0000-\u001f\u007f]/g, ''));
}

function controlPhrase(a: RecordedAction): string {
  const kind = a.role || a.tag || 'control';
  const flags: string[] = [];
  if (a.nameTruncated) flags.push('[name cut short]');
  if (a.nameProtectedDataOmitted) flags.push('[part of the name is protected]');
  const suffix = flags.length ? ` ${flags.join(' ')}` : '';
  return a.name ? `${kind} ${quoted(a.name)}${suffix}` : `an unnamed ${kind}${suffix}`;
}

function omittedValuePhrase(disposition: string): string {
  switch (disposition) {
    case 'authentication_omitted': return 'authentication data';
    case 'payment_omitted': return 'payment data';
    case 'sensitive_identity_omitted': return 'sensitive identity data';
    case 'sensitive_text_omitted': return 'sensitive credential-shaped text';
    case 'file_omitted': return 'a file';
    case 'legacy_unavailable': return 'a value';
    default: return 'a value';
  }
}

function valuePhrase(a: RecordedAction): string {
  if (a.valueDisposition === 'recorded') {
    return `${quoted(a.value)}${a.valueTruncated ? ' [value cut short]' : ''}`;
  }
  return `${omittedValuePhrase(a.valueDisposition)} (not recorded)`;
}

function detailPhrase(a: RecordedAction, fallback: string): string {
  const flags: string[] = [];
  if (a.detailTruncated) flags.push('[detail cut short]');
  if (a.detailProtectedDataOmitted) flags.push('[part of the detail is protected]');
  const text = a.detail || fallback;
  return flags.length ? `${text} ${flags.join(' ')}` : text;
}

function urlPhrase(a: RecordedAction): string {
  const flags: string[] = [];
  if (a.urlTruncated) flags.push('[address cut short]');
  if (a.urlProtectedDataOmitted) flags.push('[part of the address is protected]');
  return flags.length ? `${a.url} ${flags.join(' ')}` : a.url;
}

/** One action of a segment, by kind. */
export function describeAction(a: RecordedAction): string {
  const control = controlPhrase(a);
  switch (a.kind) {
    case 'navigate': return `opened ${urlPhrase(a)}`;
    case 'click': return a.detail ? `clicked ${control} (${detailPhrase(a, '')})` : `clicked ${control}`;
    case 'change':
      if (a.valueDisposition === 'file_omitted') return `selected a file in ${control} (not recorded)`;
      if (a.valueDisposition === 'recorded') return `entered ${valuePhrase(a)} in ${control}`;
      return `entered ${omittedValuePhrase(a.valueDisposition)} in ${control} (not recorded)`;
    case 'enter':
      return a.valueDisposition === 'recorded'
        ? `pressed Enter in ${control} (${valuePhrase(a)})`
        : `pressed Enter in ${control} (${omittedValuePhrase(a.valueDisposition)} not recorded)`;
    case 'submit': return `submitted ${control}`;
    case 'key': return `pressed ${detailPhrase(a, 'a key')} in ${control}`;
    case 'scroll': return detailPhrase(a, 'scrolled');
    case 'drag': return `dragged ${detailPhrase(a, 'a control')} to ${control}`;
    case 'contextmenu': return `opened the context menu on ${control}`;
    case 'hover': return `hovered over ${control}`;
    case 'point': return `pointed at ${control}`;
    default: return `${a.kind} ${control}`;
  }
}

/** HH:MM:SSZ of an ISO time; the raw string when it does not parse. */
export function clock(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toISOString().slice(11, 19) + 'Z';
}

/** A segment as one line: the page named once when it changes, every action
 *  in order, and the suffixes that keep it from reading as exact. A point
 *  opens differently: the person did not drive, they named one control. */
export function describeSegment(segment: RecordedSegment): string {
  const parts: string[] = [];
  let page = '';
  for (const a of segment.steps) {
    if (a.kind === 'navigate') {
      page = a.url;
      parts.push(describeAction(a));
      continue;
    }
    if (a.url && a.url !== page) {
      page = a.url;
      parts.push(`on ${urlPhrase(a)}`);
    }
    parts.push(describeAction(a));
  }
  const suffixes: string[] = [];
  if (segment.captureGap) suffixes.push(`[part of this segment was not observed: ${gapPhrase(segment.gapReason)}]`);
  if (segment.steps.some((a) => a.valueDisposition === 'legacy_unavailable')) {
    suffixes.push('[part of this segment was not observed: an entered value was not recorded]');
  }
  if (segment.live) suffixes.push('[still driving]');
  if (segment.stepsTruncated) suffixes.push('[older actions omitted from this read]');
  const body = parts.length ? parts.join('; ') : 'no action was observed';
  const tail = suffixes.length ? ` ${suffixes.join(' ')}` : '';
  if (segment.kind === 'point') {
    return `The person pointed in the browser (${clock(segment.startedAt)}): ${body}${tail}`;
  }
  const when = segment.endedAt ? `${clock(segment.startedAt)} to ${clock(segment.endedAt)}` : `from ${clock(segment.startedAt)}`;
  return `The person drove the browser themselves (${when}): ${body}${tail}`;
}

/** A browser task's sub-line. */
export function describeStep(step: RecordedStep): string {
  const flags: string[] = [];
  if (step.actionTruncated) flags.push('[action cut short]');
  if (step.protectedDataOmitted) flags.push(step.protectedKind ? `[${step.protectedKind.replace(/_/g, ' ')} value not recorded]` : '[part of the action is protected]');
  if (step.pageUrlTruncated) flags.push('[address cut short]');
  if (step.pageUrlProtectedDataOmitted) flags.push('[part of the address is protected]');
  const head = step.type === 'goto' || step.type === 'navigate' ? `${step.type} ${step.action}` : `${step.type} · ${step.action}`;
  const where = step.pageUrl && step.type !== 'goto' && step.type !== 'navigate' ? ` (on ${step.pageUrl})` : '';
  return `${head}${where}${flags.length ? ` ${flags.join(' ')}` : ''}`;
}

/** What a call was asked, as one phrase. A navigation's instruction is the
 *  address alone, so it is given its verb; every other tool's instruction
 *  already reads as a request. */
function instructionPhrase(call: RecordedCall): string {
  const text = call.instruction.replace(/\s+/g, ' ').trim();
  if (!text) return call.tool.replace(/_/g, ' ');
  return call.tool === 'navigate_browser_session' ? `open ${text}` : text;
}

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

/** An assistant call as one line: what was asked, what came of it, up to
 *  `maxSteps` of the loop's steps, and the flags that keep an altered or
 *  partial row from reading as exact. Steps past the cap are counted, never
 *  silently dropped; `maxSteps: 0` leaves the steps out of the line
 *  altogether, for a host that renders them as sub-lines of its own. */
export function describeCall(call: RecordedCall, opts: { maxSteps?: number } = {}): string {
  const maxSteps = Math.max(0, opts.maxSteps ?? CALL_STEPS_MAX);
  const outcome = call.outcome ? ` → ${clip(call.outcome, RECORD_OUTCOME_CHARS)}` : '';
  const flags: string[] = [];
  if (call.instructionTruncated) flags.push('[instruction cut short]');
  if (call.instructionProtectedDataOmitted) flags.push('[part of the instruction is protected]');
  if (call.outcomeTruncated) flags.push('[outcome cut short]');
  if (call.outcomeProtectedDataOmitted) flags.push('[part of the outcome is protected]');
  if (call.personTookOver) flags.push('[the person took over]');
  if (call.captureGap) flags.push(`[part of this task was not observed: ${gapPhrase(call.gapReason)}]`);
  if (call.stepsTruncated) flags.push('[older steps omitted from this record]');
  let steps = '';
  if (maxSteps > 0 && call.steps && call.steps.length > 0) {
    const shown = call.steps.slice(0, maxSteps).map(describeStep);
    const omitted = call.steps.length - shown.length;
    const list = shown.length > 0 ? shown.join('; ') : '';
    const more = omitted > 0 ? `${list ? '; ' : ''}[${omitted} more step${omitted === 1 ? '' : 's'} not shown]` : '';
    steps = ` (steps: ${list}${more})`;
  }
  return `${instructionPhrase(call)}${outcome}${steps}${flags.length ? ` ${flags.join(' ')}` : ''}`;
}
