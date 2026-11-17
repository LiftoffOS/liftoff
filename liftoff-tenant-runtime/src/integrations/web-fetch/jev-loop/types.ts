// The shapes the loop passes between observe, decide and act. Every field
// here is plain data the in-page snapshot returned: the host holds numbers
// and strings, never a handle, a selector or a coordinate the model chose.

export type ActionKind = 'click' | 'fill' | 'select' | 'scroll' | 'wait';

/** One executable target the snapshot offered. `node` is the code-owned
 *  identity kept in the page's WeakMap; `rect` is read again at act time. */
export interface SnapshotAction {
  id: string;
  kind: ActionKind;
  label: string;
  node?: number;
  role?: string;
  value?: string;
  current_value?: string;
  checked?: string;
  selected?: string;
  expanded?: string;
  delta?: number;
  rect?: { x: number; y: number; w: number; h: number };
  /** WAIT only: how long this wait may run before the loop looks again. The
   *  loop sets it, climbing the ladder as consecutive waits stack up. */
  waitMs?: number;
}

/** What one in-page evaluation returned. */
/** One playable file the page is showing. `src` is the address the file can
 *  actually be fetched from, which for a generated clip is often a `blob:`
 *  the page built rather than anything on a server. */
export interface PageMedia {
  kind: string;
  src: string;
  name: string;
  /** The element's readyState, when it reported one: how much of the file the
   *  browser has. Null when it reported none. */
  ready: number | null;
}

export interface PageState {
  url: string;
  title: string;
  w: number;
  h: number;
  text: string;
  /** The files on the page. A <video> carries no text, so without this a
   *  finished generator page reads as a sentence and a button, and the thing
   *  the task existed to produce is not in the observation at all. */
  media: PageMedia[];
  scroll: { y: number; height: number };
  actions: SnapshotAction[];
  marker: unknown;
  page_key: unknown;
  guards: Record<string, unknown>;
  omitted_actions: number;
  /** sha256 over url, text, actions and scroll: the page's identity for the
   *  act-once rule and the no-change rule. */
  fingerprint: string;
}

export type Operation = 'CLICK' | 'TYPE_TEXT' | 'SELECT' | 'SCROLL_UP' | 'SCROLL_DOWN' | 'WAIT' | 'DONE' | 'BLOCKED'
  /** Offered only when the task carries constraints: the action that would
   *  advance the goal from here is one they do not allow. */
  | 'CONSTRAINED';

/** One decision, as the loop records it. `choice` is the snapshot action id
 *  (or DONE / BLOCKED); a target head is consumed only for the operation
 *  chosen. */
export interface Decision {
  choice: string;
  operation: Operation;
  target: string | null;
  /** The id of the chosen literal for TYPE_TEXT (literals.ts), or null when
   *  the task supplied none that fits (the loop hands off). The literal
   *  itself is resolved at act time and never stored. */
  textId: string | null;
  confidence: number;
  probability: number;
  latencyMs: number;
  model: string;
  usage: { inputTokens: number; outputTokens: number };
}

/** One executed step in the loop's history: the reference's `history` entry,
 *  with the typed literal never stored. */
export interface HistoryEntry {
  step: number;
  action: string;
  kind: ActionKind;
  operation: Operation;
  probability: number;
  confidence: number;
  latencyMs: number;
  url: string;
  pageChanged: boolean | null;
  /** Whether a literal was typed; the literal itself is not kept. */
  typed: boolean;
}

/** The closed set of reasons the loop hands a task to its tail, or stops. */
export type HandoffReason =
  | 'blocked'
  | 'no_candidates'
  | 'text_not_in_task'
  | 'new_page'
  | 'frame_only'
  | 'file_input'
  | 'unavailable'
  | 'still_loading'
  | 'timeout';

/** Why a task stopped itself rather than handing off.
 *
 *  A constraint stop must NOT hand off. The tail is another model driving
 *  the same page from the same objective, and handing it a task that stopped
 *  because the next action would spend money is handing the forbidden click
 *  to something that was never told not to make it. */
export type SelfStopReason = 'constrained' | 'needs_a_person';

export const HANDOFF_REASONS: readonly HandoffReason[] = [
  'blocked', 'no_candidates', 'text_not_in_task', 'new_page', 'frame_only', 'file_input', 'unavailable',
  'still_loading', 'timeout',
];

/** The reference's bounds. */
export const MAX_ACTIONS = 60;

/** How long each wait in a run of them may take, climbing as they stack up:
 *  a page that is still rendering is asked about less and less often. Nothing
 *  here outruns the task's own clock, which bounds the whole run.
 *
 *  The ladder replaces dozens of 100 ms sleeps, each paid for with a decision.
 *
 *  THE TOP OF THE LADDER IS SET BY WHAT REAL PAGES DO, not by what feels
 *  long. A generator asked for a few seconds of video takes minutes, and a
 *  comparable loop elsewhere was observed waiting 48 seconds and then 35
 *  seconds in one run of the same kind of task. A ladder that gave up at
 *  forty-six seconds in total would have called that page unsettled while it
 *  was working normally. It now climbs to three quarters of a minute and
 *  totals a little over two and a half. */
export const WAIT_LADDER_MS: readonly number[] = [
  1_500, 3_000, 6_000, 10_000, 15_000, 20_000, 30_000, 30_000, 45_000,
];

/** Waits in a row before the loop stops waiting. A page still moving after
 *  the whole ladder is one that is not going to settle while anyone watches,
 *  and the task's own clock stops it sooner either way. */
export const MAX_CONSECUTIVE_WAITS = WAIT_LADDER_MS.length;
export const MAX_DECISIONS = 120;
export const RECENT_ACTIONS = 10;
