// Act: freshness first, then an in-page locate that re-reads geometry, checks
// visibility, enabled state and elementFromPoint containment and returns the
// centre, then CDP input at that point. Ported from jev-ultrafast browser.py
// (`Browser.fresh`, `Browser.act`, `browser_operation('act')`).
//
// Freshness compares semantic state, not DOM mutation counts. Before a click
// or select, a SCOPED guard: the document, the full URL, the viewport, safe
// form values and states, the target itself and its nearest form / dialog /
// row context — so unrelated visible content may change without invalidating
// (the reference lost 25% to animation invalidation). Typing, scrolling,
// waiting and completion use the FULL semantic marker. Geometry is never
// compared: it is read again immediately before input, and the executor
// rechecks visibility, enabled state and occlusion. A decision is consumed
// once, before any mutation: a retry can never double-click. Browser
// mutations are never retried by transport recovery.
//
// Typing is click, the browser's select-all command, Input.insertText, so
// existing contents are replaced. A native select sets the value in-page and
// dispatches input/change; an interrupted select evaluation stops, because
// its change event may already have fired. Scroll is a mouse wheel.
//
// A WAIT waits for the PAGE to change, up to the budget the caller gives it,
// and returns the moment it does. It used to sleep 100 ms and return, which
// cost a full decision round trip per 100 ms of waiting: a page that takes
// minutes to render a video is polled dozens of times, spends seconds waiting
// and minutes deciding, and ends at the action ceiling having done nothing.
// One decision now covers the whole wait.
//
// Model output never becomes a selector, a coordinate or JavaScript: every
// action is on an observed node re-checked before input.

import type { CDPSession, Page } from 'playwright-core';
import { JEV_GLOBAL, MARKER_SCRIPT } from './snapshot';
import { StalePage } from './observe';
import type { PageState, SnapshotAction } from './types';

export class SelectNotConfirmed extends Error {
  constructor() { super('Dropdown execution was not confirmed; inspect before retrying.'); this.name = 'SelectNotConfirmed'; }
}

async function evaluate<T>(page: Page, expression: string): Promise<T> {
  try {
    return await page.evaluate(expression) as T;
  } catch (err) {
    throw new StalePage(`Document changed during evaluation: ${(err as Error).message}`);
  }
}

function deepEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

/**
 * Is the page the decision was made on still the page in front of us? The
 * scoped guard for a click or select on a node; the full marker otherwise.
 */
export async function fresh(page: Page, state: PageState, action?: SnapshotAction): Promise<boolean> {
  if (action && (action.kind === 'click' || action.kind === 'select')) {
    const node = action.node;
    if (typeof node !== 'number') return false;
    const current = await evaluate<unknown>(page,
      `(() => { const c=window.${JEV_GLOBAL}; return c ? [c.pageKey(),c.guard(c.nodes.get(${node}))] : null; })()`);
    return deepEqual(current, [state.page_key, state.guards[String(node)] ?? null]);
  }
  const marker = await evaluate<unknown>(page, MARKER_SCRIPT);
  return deepEqual(marker, state.marker);
}

/** A wait with nothing said about how long: the first rung of the ladder the
 *  loop climbs. */
export const DEFAULT_WAIT_MS = 1_500;

/** How often the page is asked whether it has changed while a wait runs. The
 *  marker read is one evaluate; polling it is far cheaper than a decision. */
export const WAIT_POLL_MS = 250;

/** How long an action waits for its OWN effect before the loop is asked to
 *  decide anything. The reference fuses this into the action — click and watch,
 *  rather than click, then decide to wait, then wait — because "did that do
 *  anything" is not a question worth a round trip. Short: this is for a click
 *  that opens a menu or submits a form, not for a job that takes minutes. */
export const WATCH_AFTER_INPUT_MS = 1_200;

const LOCATE_SCRIPT = (action: { node: number; kind: string; value?: string }) => `(action => {
  const e=window.${JEV_GLOBAL}?.nodes.get(action.node);
  if (!e?.isConnected || e.matches(':disabled') || e.closest('[aria-disabled="true"],[inert]') ||
      !e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true})) return null;
  if (action.kind==='fill' && (e.readOnly || e.getAttribute('aria-readonly')==='true')) return null;
  const r=e.getBoundingClientRect(), x=r.x+r.width/2, y=r.y+r.height/2;
  if (!r.width || !r.height || x<0 || y<0 || x>=innerWidth || y>=innerHeight) return null;
  if (!e.contains(document.elementFromPoint(x,y))) return null;
  if (action.kind==='select') {
    if (e.tagName!=='SELECT' || ![...e.options].some(o=>o.value===action.value &&
        !o.disabled && !o.closest('optgroup[disabled]'))) return null;
    e.value=action.value;
    e.dispatchEvent(new Event('input',{bubbles:true}));
    e.dispatchEvent(new Event('change',{bubbles:true}));
  }
  return {x,y};
})(${JSON.stringify(action)})`;

const SELECT_ALL_MODIFIERS = process.platform === 'darwin' ? 4 : 2;

/**
 * Execute one decided action on the page the decision was made on. Throws
 * StalePage when the page moved (the caller discards the decision and
 * observes again), SelectNotConfirmed when a native select's evaluation was
 * interrupted. `text` is the literal to type, resolved by the caller and
 * never stored.
 *
 * Answers with what the action's own wait found, for the actions that have one
 * — a wait, and a click, which is watched. Null for the rest: a scroll and a
 * native select have no effect to watch for.
 */
export async function act(
  page: Page,
  cdp: CDPSession,
  state: PageState,
  action: SnapshotAction,
  text: string | null,
): Promise<import('./fence').FenceVerdict | null> {
  if (!(await fresh(page, state, action))) {
    throw new StalePage('Page changed since this decision. Observe again.');
  }
  if (action.kind === 'wait') {
    const { fence } = await import('./fence');
    return fence(page, state, action.waitMs ?? DEFAULT_WAIT_MS);
  }
  if (action.kind === 'scroll') {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseWheel', x: 550, y: 650, deltaX: 0, deltaY: action.delta ?? 560 });
    return null;
  }
  if (typeof action.node !== 'number') throw new Error('Invalid observed node');
  let target: { x: number; y: number } | null;
  try {
    target = await evaluate<{ x: number; y: number } | null>(page, LOCATE_SCRIPT({ node: action.node, kind: action.kind, value: action.value }));
  } catch (err) {
    if (action.kind === 'select') throw new SelectNotConfirmed();
    throw err;
  }
  if (target === null) {
    if (action.kind === 'select') throw new SelectNotConfirmed();
    throw new StalePage('Target changed or is covered. Observe again.');
  }
  if (action.kind === 'select') return null;
  const { x, y } = target;
  await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
  if (action.kind === 'fill') {
    if (text === null) throw new Error('TYPE_TEXT with no literal');
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', modifiers: SELECT_ALL_MODIFIERS, commands: ['selectAll'] });
    await cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', modifiers: SELECT_ALL_MODIFIERS });
    await cdp.send('Input.insertText', { text });
    // Typing does not navigate, so there is nothing to watch for: the
    // reference has no watching variant of it either.
    return null;
  }
  // Click and WATCH. The click's own effect is waited for here rather than
  // becoming a question the model has to think about: a click that opens a
  // menu, submits a form or starts a job has an effect worth a moment, and
  // spending a decision to discover that is a round trip for nothing.
  const { fence } = await import('./fence');
  return fence(page, state, WATCH_AFTER_INPUT_MS);
}


