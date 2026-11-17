// The work record: the trail of a conversation as one numbered sequence of
// what was done, the person's own browser segments in their place in time.
//
// Deterministic: the same conversation renders the same record, so the
// workflows section drafted from it does not depend on how the model happened
// to read the JSON. One line per tool call; a browser task's own steps as
// sub-lines under it; and each segment the person drove the browser
// themselves as a numbered line of its own, placed by time:
//
//   - after the last message whose createdAt <= the segment's startedAt;
//   - if that message is the person's and an assistant message follows it,
//     within that assistant message's browser sub-steps by each step's `at`
//     when the steps carry one: a segment that overlaps a task appears after
//     the last step before its start and before the first step after its
//     end. A step without a time of its own (a vendor's native step the
//     observer did not see, kept in loop order beside the observed ones)
//     takes the nearest observed step's time, so it stays where the loop put
//     it; older sub-steps with no timestamps at all use the after-turn
//     fallback;
//   - segments after every message go at the end;
//   - ties by timestamp, then the order the runtime returned them.
//
// The source-conversation read renders the same placement inside a runtime
// activity row through `placeSegmentsAmongSteps`, so the two records agree.
//
// Everything that keeps a partial or altered record from reading as exact is
// rendered beside its line: a segment's capture gap (the closed vocabulary
// mapped to a phrase, an unknown reason to a generic one), a live segment,
// actions omitted from the read, every truncation and protected-text
// omission flag, a task's own gap and truncation, and a `record_gap`
// sentinel as a missing range. A recorded value is quoted with JSON string
// escaping after control characters are removed; a page-authored name is
// escaped the same way; an omitted value names its protected class and says
// `(not recorded)`.

import {
  describeCall as describeRecordedCall,
  describeSegment,
  describeStep,
  type RecordedAction,
  type RecordedCall,
  type RecordedSegment,
} from '@liftoffos/browser-record';
import type { TeamPlanChatMessage, ToolTrailEntry, ToolTrailStep } from './chat-repository.js';

// The segment, the action, the call and their prose (describeAction,
// describeSegment, describeStep, describeCall, gapPhrase, quoted) live in
// @liftoffos/browser-record now, so the tenant runtime, platform-backend and
// this service phrase the record the same way. The types below are this
// service's names for the wire shapes; the work-record test pins them
// assignable to the package's, and `toRecordedCall` projects this service's
// own trail entry onto the package's call.
export {
  GAP_PHRASES, describeAction, describeSegment, describeStep, gapPhrase, quoted,
} from '@liftoffos/browser-record';

const RECORD_ARG_CHARS = 160;

/** The pane tools whose one argument IS the instruction: the record reads
 *  `open <url>` and the task's own words, as the runtime's rows do. */
const INSTRUCTION_ARG: Record<string, string> = {
  navigate_browser_session: 'url',
  run_browser_task: 'prompt',
};

/** One of the person's actions in a segment, as platform-backend returns it. */
export interface TakeoverSegmentAction {
  kind: string;
  url: string;
  tag: string;
  role: string;
  name: string;
  inputType: string;
  at: string;
  value: string;
  valueDisposition: string;
  detail: string;
  urlTruncated: boolean;
  nameTruncated: boolean;
  valueTruncated: boolean;
  detailTruncated: boolean;
  urlProtectedDataOmitted: boolean;
  nameProtectedDataOmitted: boolean;
  detailProtectedDataOmitted: boolean;
}

/** One segment the person drove the browser themselves, or one control they
 *  pointed at without taking over (kind "point"). */
export interface TakeoverSegment {
  tool: 'person_takeover';
  steps: TakeoverSegmentAction[];
  live: boolean;
  captureGap: boolean;
  gapReason: string;
  startedAt: string;
  endedAt: string | null;
  stepsTruncated?: boolean;
  /** Absent reads as "takeover". */
  kind?: 'takeover' | 'point';
}

// The renderers take the package's shapes; this service's are the same
// fields, asserted so at compile time here and pinned in the test.
const _actionIsRecorded: RecordedAction = {} as TakeoverSegmentAction;
const _segmentIsRecorded: RecordedSegment = {} as TakeoverSegment;
void _actionIsRecorded;
void _segmentIsRecorded;

/** The tool name of a capped turn's sentinel (tool-trail.ts). */
const RECORD_GAP_TOOL = 'record_gap';

/**
 * This service's trail entry as the package's recorded call. A pane tool
 * whose one argument is the instruction hands it over as such; any other
 * tool's instruction is its name and its arguments, so the line still says
 * what was called. The person's takeovers are their own segments here, never
 * a flag on a call, and a trail entry carries no time of its own: the
 * message it belongs to is placed by the message's time.
 */
export function toRecordedCall(entry: ToolTrailEntry): RecordedCall {
  const key = INSTRUCTION_ARG[entry.tool];
  const instruction = key !== undefined && typeof entry.input[key] === 'string'
    ? (entry.input[key] as string)
    : (() => { const args = renderArgs(entry.input); return args ? `${entry.tool} (${args})` : entry.tool; })();
  return {
    tool: entry.tool,
    instruction,
    outcome: entry.outcome,
    personTookOver: false,
    steps: entry.steps ?? null,
    createdAt: '',
    instructionTruncated: entry.inputTruncated === true,
    outcomeTruncated: entry.outcomeTruncated === true,
    instructionProtectedDataOmitted: entry.inputProtectedDataOmitted === true,
    outcomeProtectedDataOmitted: entry.outcomeProtectedDataOmitted === true,
    captureGap: entry.captureGap === true,
    gapReason: entry.gapReason ?? '',
    ...(entry.stepsTruncated ? { stepsTruncated: true as const } : {}),
  };
}

/** A tool call as its numbered line: the package's phrasing of the call,
 *  its steps left to the sub-lines under it; a capped turn's sentinel as
 *  the missing range it stands for. */
export function describeCall(entry: ToolTrailEntry): string {
  if (entry.tool === RECORD_GAP_TOOL) {
    const omitted = typeof entry.input.omitted === 'number' ? entry.input.omitted : undefined;
    return `[${omitted !== undefined ? `${omitted} later tool call${omitted === 1 ? '' : 's'}` : 'later tool calls'} of this turn ${omitted === 1 ? 'is' : 'are'} not in the record]`;
  }
  return describeRecordedCall(toRecordedCall(entry), { maxSteps: 0 });
}

function renderArgs(input: Record<string, unknown>): string {
  if ('_omitted' in input) return String(input._omitted);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(input)) {
    const value = typeof v === 'string' ? v : JSON.stringify(v);
    if (value === undefined) continue;
    parts.push(`${k}: ${clip(value, RECORD_ARG_CHARS)}`);
  }
  return parts.join(', ');
}

function clip(text: string, max: number): string {
  const oneLine = text.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

// ── Placement ─────────────────────────────────────────────────────────────

/** A segment's interval, as the placement compares it. */
export interface SegmentInterval {
  startedAt: number;
  endedAt: number;
}

/**
 * Each step's placement time: its own `at`; else the nearest preceding timed
 * step's, else the first following timed step's. Null when no step carries a
 * time, which is the after-turn fallback.
 */
export function stepTimes(steps: readonly ToolTrailStep[]): number[] | null {
  const own = steps.map((s) => time(s.at));
  if (!own.some((t) => !Number.isNaN(t))) return null;
  const out = own.slice();
  let last = Number.NaN;
  for (let i = 0; i < out.length; i++) {
    if (Number.isNaN(out[i])) out[i] = last; else last = out[i];
  }
  let next = Number.NaN;
  for (let i = out.length - 1; i >= 0; i--) {
    if (Number.isNaN(out[i])) out[i] = next; else next = out[i];
  }
  return out;
}

/**
 * Emit a call's sub-steps with the pending segments placed among them by
 * time: a segment goes after the last step before its start and before the
 * first step after its end. Answers the segments still pending, which belong
 * after the call: those that had not ended by its last step and had not
 * started by it either. With no timestamps at all, the steps are emitted
 * plainly and every segment stays pending (the after-turn fallback).
 */
export function placeSegmentsAmongSteps<S extends SegmentInterval>(
  steps: readonly ToolTrailStep[],
  pending: readonly S[],
  emit: { step(step: ToolTrailStep, continued: boolean): void; segment(segment: S): void },
): S[] {
  const times = stepTimes(steps);
  if (times === null) {
    for (const step of steps) emit.step(step, false);
    return [...pending];
  }
  const remaining = [...pending];
  let interrupted = false;
  steps.forEach((step, i) => {
    while (remaining.length > 0 && remaining[0].endedAt <= times[i]) {
      emit.segment(remaining.shift()!);
      interrupted = true;
    }
    emit.step(step, interrupted);
  });
  // A segment that started before the call's last step but has not ended
  // by it belongs after the call, not inside a later one.
  const lastAt = times[times.length - 1];
  while (remaining.length > 0 && remaining[0].startedAt <= lastAt) emit.segment(remaining.shift()!);
  return remaining;
}

interface PlacedSegment extends SegmentInterval {
  segment: TakeoverSegment;
  order: number;
}

/** A message with its trail entries, or the person's message. */
interface MessageSlot {
  index: number;
  role: string;
  createdAt: number;
  entries: ToolTrailEntry[];
}

function time(iso: string | null | undefined): number {
  if (!iso) return Number.NaN;
  const t = new Date(iso).getTime();
  return Number.isNaN(t) ? Number.NaN : t;
}

export interface WorkRecord {
  lines: string[];
  /** For each message, in order, the record numbers its trail entries took. */
  stepsByMessage: number[][];
}

/**
 * Build the record: one numbered sequence, the segments placed by time.
 */
export function buildWorkRecord(
  messages: readonly TeamPlanChatMessage[],
  takeovers: readonly TakeoverSegment[] = [],
): WorkRecord {
  const slots: MessageSlot[] = messages.map((m, index) => ({
    index, role: m.role, createdAt: time(m.createdAt), entries: m.role === 'assistant' ? m.toolTrail : [],
  }));
  const segments: PlacedSegment[] = takeovers
    .map((segment, order) => ({
      segment, order,
      startedAt: time(segment.startedAt),
      endedAt: segment.endedAt ? time(segment.endedAt) : Number.POSITIVE_INFINITY,
    }))
    .sort((a, b) => (a.startedAt - b.startedAt) || (a.order - b.order));

  // Which slot each segment lands after, and whether it can go inside the
  // following assistant message's sub-steps.
  const afterSlot = new Map<number, PlacedSegment[]>();
  const atEnd: PlacedSegment[] = [];
  for (const placed of segments) {
    let last = -1;
    for (const slot of slots) {
      if (!Number.isNaN(slot.createdAt) && !Number.isNaN(placed.startedAt) && slot.createdAt <= placed.startedAt) last = slot.index;
    }
    if (last === -1 && slots.length > 0 && Number.isNaN(placed.startedAt)) last = slots.length - 1;
    if (last === -1) {
      // Before every message, or a segment with no time: after nothing.
      const list = afterSlot.get(-1) ?? [];
      list.push(placed);
      afterSlot.set(-1, list);
      continue;
    }
    if (last === slots.length - 1) {
      atEnd.push(placed);
      continue;
    }
    const list = afterSlot.get(last) ?? [];
    list.push(placed);
    afterSlot.set(last, list);
  }

  const lines: string[] = [];
  const stepsByMessage: number[][] = messages.map(() => []);
  let n = 0;
  const emitSegment = (placed: PlacedSegment) => {
    n += 1;
    lines.push(`${n}. ${describeSegment(placed.segment)}`);
  };
  const emitEntry = (slot: MessageSlot, entry: ToolTrailEntry, within: PlacedSegment[]): PlacedSegment[] => {
    n += 1;
    const number = n;
    stepsByMessage[slot.index].push(number);
    lines.push(`${number}. ${describeCall(entry)}`);
    // A segment that overlaps this task appears after the last step before
    // its start and before the first step after its end; the steps inside
    // the segment's interval are the person's, not the task's, and the
    // runtime already kept them out of the task's trail.
    return placeSegmentsAmongSteps(entry.steps ?? [], within, {
      step: (step, continued) => lines.push(`   - ${continued ? `(step ${number} continued) ` : ''}${describeStep(step)}`),
      segment: emitSegment,
    });
  };

  for (const placed of afterSlot.get(-1) ?? []) emitSegment(placed);
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    // Segments placed after the previous message may go inside THIS assistant
    // message's sub-steps when the previous message was the person's.
    const previous = i > 0 ? slots[i - 1] : null;
    let carried: PlacedSegment[] = [];
    if (previous && previous.role === 'user' && slot.role === 'assistant') {
      carried = afterSlot.get(previous.index) ?? [];
      afterSlot.delete(previous.index);
    }
    if (slot.role === 'assistant') {
      for (const entry of slot.entries) carried = emitEntry(slot, entry, carried);
    }
    for (const placed of carried) emitSegment(placed);
    // A segment after the person's message waits for the assistant message
    // that answers it, which may place it among its sub-steps.
    const next = i + 1 < slots.length ? slots[i + 1] : null;
    if (slot.role === 'user' && next?.role === 'assistant') continue;
    for (const placed of afterSlot.get(slot.index) ?? []) emitSegment(placed);
    afterSlot.delete(slot.index);
  }
  for (const placed of atEnd) emitSegment(placed);
  return { lines, stepsByMessage };
}

/**
 * The trail as an ordered list of what was done, one line per call, the
 * person's segments in their place: the record alone.
 */
export function renderWorkRecord(
  messages: readonly TeamPlanChatMessage[],
  takeovers: readonly TakeoverSegment[] = [],
): string[] {
  return buildWorkRecord(messages, takeovers).lines;
}
