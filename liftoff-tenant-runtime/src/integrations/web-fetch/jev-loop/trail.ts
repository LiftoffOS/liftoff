// The loop's trail: every step BY SHAPE — the operation, the control's role
// and name, the page — with the name sanitised before storage and the typed
// literal never stored. A handoff is one more step, with a reason from the
// closed enum. The CAIO reads structured actions, and the Stagehand
// step-policy scrub never runs on a Jev-handled task.

import { sanitizeBrowserText, recordedUrl } from '@liftoffos/redact';
import type { BrowserTaskStep, BrowserTaskTrail } from '../step-policy';
import { HANDOFF_REASONS, type Decision, type HandoffReason, type SnapshotAction } from './types';

/** Longest control name kept in a step. */
export const STEP_NAME_CAP = 200;

export interface JevTrailStep extends BrowserTaskStep {
  /** The decision's probability and confidence, recorded per step. */
  probability: number;
  confidence: number;
}

/** One executed step. */
export function stepFor(decision: Decision, action: SnapshotAction, pageUrl: string, at: Date): JevTrailStep {
  const name = sanitizeBrowserText(action.label.split(' → ')[0], STEP_NAME_CAP);
  const url = recordedUrl(pageUrl);
  return {
    type: decision.operation,
    action: `${action.role ?? action.kind} · ${name.text}`,
    pageUrl: url.text,
    actionTruncated: name.truncated,
    pageUrlTruncated: url.truncated,
    protectedDataOmitted: name.protectedDataOmitted,
    protectedKind: name.protectedDataOmitted ? 'literal' : '',
    pageUrlProtectedDataOmitted: url.protectedDataOmitted,
    at,
    probability: decision.probability,
    confidence: decision.confidence,
  };
}

/** The handoff step: a closed-enum reason, no goal text. A reason outside
 *  the enum can only come from a defect; it is recorded as `unavailable`
 *  rather than as free text on a row a person reads. */
export function handoffStep(reason: HandoffReason, pageUrl: string, at: Date): JevTrailStep {
  const url = recordedUrl(pageUrl);
  return {
    type: 'handoff',
    action: HANDOFF_REASONS.includes(reason) ? reason : 'unavailable',
    pageUrl: url.text,
    actionTruncated: false,
    pageUrlTruncated: url.truncated,
    protectedDataOmitted: false,
    protectedKind: '',
    pageUrlProtectedDataOmitted: url.protectedDataOmitted,
    at,
    probability: 0,
    confidence: 0,
  };
}

/** The step for the one navigation the loop makes: the address the task
 *  named, opened because the browser was on a blank page. Typed `goto` so the
 *  record renders it as the record renders every other navigation. */
export function navigateStep(url: string, at: Date): JevTrailStep {
  const recorded = recordedUrl(url);
  return {
    type: 'goto',
    action: recorded.text,
    pageUrl: recorded.text,
    actionTruncated: recorded.truncated,
    pageUrlTruncated: recorded.truncated,
    protectedDataOmitted: false,
    protectedKind: '',
    pageUrlProtectedDataOmitted: recorded.protectedDataOmitted,
    at,
    probability: 0,
    confidence: 0,
  };
}

/** A DONE step carrying the goal check's probability on the trail's last step. */
export function doneStep(decision: Decision, goalProbability: number, pageUrl: string, at: Date): JevTrailStep {
  const url = recordedUrl(pageUrl);
  return {
    type: 'DONE',
    action: 'done',
    pageUrl: url.text,
    actionTruncated: false,
    pageUrlTruncated: url.truncated,
    protectedDataOmitted: false,
    protectedKind: '',
    pageUrlProtectedDataOmitted: url.protectedDataOmitted,
    at,
    probability: goalProbability,
    confidence: decision.confidence,
  };
}

export const COMPLETED_MESSAGE = 'Browser task completed';
export const STOPPED_MESSAGE = 'Browser task stopped';

export function trailOf(steps: JevTrailStep[], message: string): BrowserTaskTrail {
  return { message, steps, captureGap: false, gapReason: null, stepsTruncated: false };
}

/** The Jev steps followed by the tail's, under the tail's message. */
export function mergeTrails(head: BrowserTaskTrail, tail: BrowserTaskTrail): BrowserTaskTrail {
  return {
    message: tail.message,
    steps: [...head.steps, ...tail.steps],
    captureGap: head.captureGap || tail.captureGap,
    gapReason: tail.gapReason ?? head.gapReason,
    stepsTruncated: head.stepsTruncated || tail.stepsTruncated,
  };
}
