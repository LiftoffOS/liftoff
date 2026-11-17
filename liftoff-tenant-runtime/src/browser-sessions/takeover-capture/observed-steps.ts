// A task's observed steps, and how they are reconciled with the vendor's own.
//
// `TaskCapture` observes the DOM for the length of one in-session agent task
// and hands back the same safe actions a takeover hold records. Those are
// the authority for state-changing behaviour and entered values: the
// recorder classified the actual containing form before reading a value,
// which Stagehand's prose cannot do and Anchor's loop does not report at
// all. This module turns them into the steps the record keeps and, for a
// Stagehand-backed vendor, folds them into the loop's native action list:
//
//   collapse   a native act / fillForm / goto / scroll whose observed DOM or
//              navigation step represents it is replaced by the observed
//              step(s), in their place
//   retain     a native extract, wait, screenshot, ariaTree, navback or
//              close is not a DOM action and stays where it was
//   fallback   a native act / fillForm / goto / scroll that no observed step
//              represents (the observer missed it) keeps its sanitized
//              projection
//
// Both lists are ordered in time (the observed steps by their timestamps,
// the native list by the loop's order), so the alignment walks them
// together. When a native step that should have a DOM counterpart finds none
// while observed steps of its kind are still unconsumed further on, the
// alignment could be wrong either way: that is reported as
// `reconciliation_uncertain`, never as an exact trail.

import type { BrowserTaskStep, TrailGapReason } from '../../integrations/web-fetch/step-policy';
import type { ObservedAction, TaskCaptureResult } from './index';
import type { TakeoverActionRow } from './action';

/** The class an omitted value belongs to, as the step names it. */
function omittedPhrase(disposition: TakeoverActionRow['valueDisposition']): string {
  switch (disposition) {
    case 'authentication_omitted': return 'authentication data (not recorded)';
    case 'payment_omitted': return 'payment data (not recorded)';
    case 'sensitive_identity_omitted': return 'sensitive identity data (not recorded)';
    case 'file_omitted': return 'a file (not recorded)';
    case 'sensitive_text_omitted': return 'sensitive credential-shaped text (not recorded)';
    case 'legacy_unavailable': return 'a value (not recorded)';
    default: return '';
  }
}

function protectedKindOf(disposition: TakeoverActionRow['valueDisposition']): string {
  switch (disposition) {
    case 'authentication_omitted': return 'authentication';
    case 'payment_omitted': return 'payment';
    case 'sensitive_identity_omitted': return 'sensitive_identity';
    case 'file_omitted': return 'file';
    case 'sensitive_text_omitted': return 'sensitive_text';
    default: return '';
  }
}

/** The control, as the page names it. */
function controlPhrase(row: TakeoverActionRow): string {
  const kind = row.role || row.tag || 'control';
  return row.name ? `${kind} ${JSON.stringify(row.name)}` : `an unnamed ${kind}`;
}

/** One observed action as a step's phrase. */
export function observedActionPhrase(row: TakeoverActionRow): string {
  const control = controlPhrase(row);
  const value = row.valueDisposition === 'recorded'
    ? JSON.stringify(row.value ?? '')
    : omittedPhrase(row.valueDisposition);
  switch (row.kind) {
    case 'navigate': return `opened ${row.url}`;
    case 'click': return `clicked ${control}${row.detail ? ` (${row.detail})` : ''}`;
    case 'change': return `entered ${value} in ${control}`;
    case 'enter': return `pressed Enter in ${control} (${value})`;
    case 'submit': return `submitted ${control}`;
    case 'key': return `pressed ${row.detail ?? 'a key'} in ${control}`;
    case 'scroll': return row.detail ?? 'scrolled';
    case 'drag': return `dragged ${row.detail ?? 'a control'} to ${control}`;
    case 'contextmenu': return `opened the context menu on ${control}`;
    case 'hover': return `hovered over ${control}`;
  }
}

/** Observed actions as the steps the record keeps, oldest first. */
export function observedStepsFrom(actions: ReadonlyArray<ObservedAction>): BrowserTaskStep[] {
  return actions.map(({ row, at }) => ({
    type: row.kind,
    action: observedActionPhrase(row),
    pageUrl: row.url,
    actionTruncated: row.nameTruncated || row.valueTruncated || row.detailTruncated,
    pageUrlTruncated: row.urlTruncated,
    protectedDataOmitted: row.valueDisposition !== 'none' && row.valueDisposition !== 'recorded'
      || row.nameProtectedDataOmitted || row.detailProtectedDataOmitted,
    protectedKind: protectedKindOf(row.valueDisposition),
    pageUrlProtectedDataOmitted: row.urlProtectedDataOmitted,
    at,
  }));
}

/** Which observed kinds represent a native Stagehand step. A fillForm sets
 *  fields (a run of `change`); the Enter that follows is a `press` act. */
const REPRESENTED_BY: Record<string, ReadonlySet<string>> = {
  act: new Set(['click', 'change', 'enter', 'key', 'contextmenu', 'drag', 'hover', 'submit']),
  fillForm: new Set(['change']),
  goto: new Set(['navigate']),
  scroll: new Set(['scroll']),
};

/** How far ahead in the observed list a native step may find its
 *  counterpart. A page-level noise action (a hover, a scroll the loop did
 *  not ask for) between two acts must not break the alignment. */
const LOOKAHEAD = 6;

/** Whether the native step's own text names the observed control or value:
 *  every quoted string in the observed phrase (the control's name, the
 *  entered value) found in the native text, case-insensitively. A confirmed
 *  pairing is exact; an unconfirmed one is a guess by order. */
function affinity(nativeText: string, observedText: string): boolean {
  // Typed explicitly: `RegExpMatchArray | never[]` resolves `.some`'s
  // callback parameter to `never` in some checker orders, which surfaced as
  // a type error the moment an unrelated module was added to the program.
  const quoted: string[] = observedText.match(/"((?:[^"\\]|\\.)*)"/g) ?? [];
  if (quoted.length === 0) return false;
  const haystack = nativeText.toLowerCase();
  return quoted.some((q) => {
    const inner = q.slice(1, -1).toLowerCase();
    return inner.length > 0 && haystack.includes(inner);
  });
}

export interface ReconciledTrail {
  steps: BrowserTaskStep[];
  captureGap: boolean;
  gapReason: TrailGapReason | null;
  stepsTruncated: boolean;
}

/**
 * Fold the observed steps into the native list, or, when the vendor
 * reported no native steps at all (Anchor), use the observed steps alone.
 */
export function reconcileTrail(
  native: ReadonlyArray<BrowserTaskStep> | null,
  observed: ReadonlyArray<BrowserTaskStep>,
  capture: Pick<TaskCaptureResult, 'captureGap' | 'gapReason' | 'stepsTruncated'>,
): ReconciledTrail {
  let gapReason: TrailGapReason | null = capture.captureGap ? (capture.gapReason ?? 'reconciliation_uncertain') : null;
  if (native === null) {
    return { steps: observed.slice(), captureGap: gapReason !== null, gapReason, stepsTruncated: capture.stepsTruncated };
  }
  const out: BrowserTaskStep[] = [];
  let oi = 0;
  let unconfirmed = 0;
  let unmatched = 0;
  let matched = 0;
  let waitingBehind = false;
  for (const step of native) {
    const kinds = REPRESENTED_BY[step.type];
    if (!kinds) {
      out.push(step);
      continue;
    }
    // The nearest kind match, unless a confirmed one (the native text names
    // the observed control or value) sits within the window.
    let found = -1;
    let confirmed = false;
    for (let j = oi; j < observed.length && j < oi + LOOKAHEAD; j++) {
      if (!kinds.has(observed[j].type)) continue;
      if (affinity(step.action, observed[j].action)) { found = j; confirmed = true; break; }
      if (found === -1) found = j;
    }
    if (found === -1) {
      // The observer missed it: keep the sanitized native projection. When
      // observed steps of this kind are still waiting further on, the
      // alignment may be wrong either way.
      unmatched++;
      if (observed.slice(oi).some((o) => kinds.has(o.type))) waitingBehind = true;
      out.push(step);
      continue;
    }
    matched++;
    if (!confirmed) unconfirmed++;
    // Everything observed up to the counterpart is real and precedes it.
    for (let j = oi; j <= found; j++) out.push(observed[j]);
    oi = found + 1;
    // A fillForm is several entries: consume the run of field settings that
    // follows.
    if (step.type === 'fillForm') {
      while (oi < observed.length && kinds.has(observed[oi].type)) out.push(observed[oi++]);
    }
  }
  for (; oi < observed.length; oi++) out.push(observed[oi]);
  // Ambiguity: a pairing made by order alone beside a native step that found
  // nothing, or a miss with counterparts still waiting. And an observer that
  // saw NOTHING of a loop that reports DOM actions: the events may not have
  // reached the isolated world as trusted, and a trail built from the
  // vendor's prose alone fails closed as a gap rather than passing as exact.
  const uncertain = waitingBehind || (unconfirmed > 0 && unmatched > 0) || (matched === 0 && unmatched > 0);
  if (uncertain && gapReason === null) gapReason = 'reconciliation_uncertain';
  return { steps: out, captureGap: gapReason !== null, gapReason, stepsTruncated: capture.stepsTruncated };
}
