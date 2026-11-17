// Side-channel for what a workflow `capability` step's tools actually produced.
//
// A capability step runs as a micro-turn: the model searches, runs a
// capability, and speaks. Whether it GOT anything is not in what it says — a
// model told "this capability did not return a result" will say so in prose,
// and prose is not a signal the executor can act on. What the executor needs
// is the typed outcome of each tool call the turn made: did run_capability
// answer with data, did a web tool return content. Those outcomes are seen in
// the tool handler, one request away from the step that opened the turn, in
// the SAME process — the capability-approval-signal pattern, in the other
// direction: the step OPENS a window, the handler NOTES into it, the step
// CLOSES it and reads the counts. Nothing the model controls reaches this
// map; a note is recorded from the handler's typed result, never from text.
//
// Keyed by invocation and by the window the step opened, so a note from a
// turn that is not inside a window is dropped, and a close that names a
// window other than the open one reads as nothing rather than as another
// step's counts. One window per invocation at a time: steps run in sequence.

import { logger } from '../infrastructure/logging';

export interface CapabilityWindowCounts {
  /** run_capability calls the window saw. */
  capabilityRuns: number;
  /** run_capability calls that ran AND answered (`ok && !empty`). */
  capabilitySuccesses: number;
  /** Read-only web tool calls the window saw. */
  webRuns: number;
  /** Web tool calls whose handler returned actual content. */
  webSuccesses: number;
}

interface OpenWindow {
  windowId: string;
  counts: CapabilityWindowCounts;
}

const windows = new Map<string, OpenWindow>();

const CAPABILITY_RUN_TOOL = 'run_capability';

/** The web tools whose outcomes a window counts, as the handler dispatches
 *  them: every read-only web tool the fallback turn may use (the allowlist in
 *  engine/capability-step-prompt.ts, pinned equal by a test) plus `web_task`,
 *  a browser task whose returned content meets a need as well as a fetch
 *  does. A first turn that met its need with any of these has no reason for
 *  a second. */
export const WEB_OUTCOME_TOOLS: ReadonlySet<string> = new Set([
  'web_fetch_advanced', 'web_extract', 'web_diff', 'web_task', 'web_search', 'web_research',
  'web_people_search', 'web_x_search', 'web_finance_search', 'web_deep_research',
]);

function fresh(): CapabilityWindowCounts {
  return { capabilityRuns: 0, capabilitySuccesses: 0, webRuns: 0, webSuccesses: 0 };
}

/** The step opens its window before its first micro-turn. A window left
 *  open by an earlier step of the same invocation is replaced and logged: a
 *  step that never closed is a bug, not a state to inherit. */
export function openCapabilityWindow(invocationId: string, windowId: string): void {
  const existing = windows.get(invocationId);
  if (existing) {
    logger.warn(
      { invocation_id: invocationId, open_window: existing.windowId, new_window: windowId },
      'capability outcome window opened over one still open; the earlier one is discarded',
    );
  }
  windows.set(invocationId, { windowId, counts: fresh() });
}

/** The handler notes one tool's typed outcome. `useful` is the handler's
 *  judgement from its own result — a capability that ran and answered, a web
 *  tool that returned content — never the model's text. A note with no open
 *  window (a conversational turn, a step of another kind) is dropped. */
export function noteToolOutcome(invocationId: string | undefined, toolName: string, useful: boolean): void {
  if (!invocationId) return;
  const window = windows.get(invocationId);
  if (!window) return;
  if (toolName === CAPABILITY_RUN_TOOL) {
    window.counts.capabilityRuns += 1;
    if (useful) window.counts.capabilitySuccesses += 1;
    return;
  }
  if (WEB_OUTCOME_TOOLS.has(toolName)) {
    window.counts.webRuns += 1;
    if (useful) window.counts.webSuccesses += 1;
  }
}

/** The step closes its window — in a `finally`, so a pause or an error
 *  inside the turn closes it too — and reads what the turn produced. A close
 *  naming a window that is not the open one reads zeros: the counts belong
 *  to whichever step opened it. */
export function closeCapabilityWindow(invocationId: string, windowId: string): CapabilityWindowCounts {
  const window = windows.get(invocationId);
  if (!window || window.windowId !== windowId) {
    if (window) {
      logger.warn(
        { invocation_id: invocationId, open_window: window.windowId, closing: windowId },
        'capability outcome window closed by a step that did not open it; counts not released',
      );
    }
    return fresh();
  }
  windows.delete(invocationId);
  return window.counts;
}

/** Whether a web tool's handler result carries actual content: a success
 *  whose result is not blank, not an empty list, not an envelope whose lists
 *  are all empty. `{ results: [] }` and a blank answer do not count. */
export function webResultHasContent(result: { success: boolean; result?: unknown } | null | undefined): boolean {
  if (!result || !result.success) return false;
  return hasContent(result.result, 0);
}

const CONTENT_FREE_KEYS = new Set(['total', 'count', 'query', 'took', 'status', 'success', 'ok', 'cursor', 'next', 'hasMore', 'has_more', 'page', 'limit', 'offset', 'message', 'warning', 'warnings', 'meta', 'metadata']);

function hasContent(value: unknown, depth: number): boolean {
  if (value === null || value === undefined) return false;
  if (typeof value === 'string') return value.trim().length > 0;
  if (typeof value === 'number' || typeof value === 'boolean') return true;
  if (depth > 8) return true;
  if (Array.isArray(value)) return value.some((v) => hasContent(v, depth + 1));
  if (typeof value === 'object') {
    return Object.entries(value as Record<string, unknown>)
      .some(([key, field]) => !CONTENT_FREE_KEYS.has(key) && hasContent(field, depth + 1));
  }
  return false;
}

/** Test seam. */
export function _resetCapabilityWindows(): void {
  windows.clear();
}
