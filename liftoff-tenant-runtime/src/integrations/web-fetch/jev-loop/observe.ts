// Observe: evaluate the snapshot, after the post-interaction wait the
// reference defines. Ported from jev-ultrafast browser.py (`Browser.observe`
// and `browser_operation('observe')`).
//
// The wait runs AFTER execution was recorded, so a navigation that interrupts
// it cannot erase the action: at most two animation frames or 50 ms after an
// interaction; after typing into a combobox, until suggestions are visible,
// capped at 200 ms. An explicit WAIT is 100 ms, applied in act.ts.

import { createHash } from 'crypto';
import type { Page } from 'playwright-core';
import { SNAPSHOT_SCRIPT, JEV_GLOBAL } from './snapshot';
import { filesBlock } from '../../../browser-sessions/page-media';
import type { PageState, SnapshotAction } from './types';

export class StalePage extends Error {
  constructor(message: string) { super(message); this.name = 'StalePage'; }
}

/** The reference's fingerprint: sha256 over url, text, actions and scroll. */
export function fingerprint(state: Pick<PageState, 'url' | 'text' | 'actions' | 'scroll'>): string {
  const content = JSON.stringify({ url: state.url, text: state.text, actions: state.actions, scroll: state.scroll }, stableKeys);
  return createHash('sha256').update(content).digest('hex');
}

function stableKeys(_key: string, value: unknown): unknown {
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    return Object.fromEntries(Object.keys(value as Record<string, unknown>).sort().map((k) => [k, (value as Record<string, unknown>)[k]]));
  }
  return value;
}

/** The post-interaction wait, verbatim in behaviour from the reference. */
function afterInputScript(action: SnapshotAction): string {
  return `(action => new Promise(resolve => {
    const field=window.${JEV_GLOBAL}?.nodes.get(action.node);
    const autocomplete=action.kind==='fill' && field?.getAttribute('role')==='combobox';
    let frames=0, stopped=false;
    const finish=()=>{stopped=true;resolve()};
    setTimeout(finish,autocomplete ? 200 : 50);
    const ready=()=>{
      if (stopped) return;
      const ids=(field?.getAttribute('aria-controls')||field?.getAttribute('aria-owns')||'')
        .split(/\\s+/).filter(Boolean);
      const roots=ids.length ? ids.map(id=>document.getElementById(id)).filter(Boolean) : [document];
      const options=roots.flatMap(root=>[...root.querySelectorAll('[role="option"]')]);
      if (++frames>=2 && (!autocomplete || options.some(e=>{
        const r=e.getBoundingClientRect();
        return r.width && r.height && r.bottom>0 && r.top<innerHeight &&
          e.checkVisibility({checkOpacity:true,checkVisibilityCSS:true});
      }))) finish();
      else requestAnimationFrame(ready);
    };
    requestAnimationFrame(ready);
  }))(${JSON.stringify({ node: action.node, kind: action.kind })})`;
}

async function evaluateRaw<T>(page: Page, expression: string): Promise<T> {
  try {
    return await page.evaluate(expression) as T;
  } catch (err) {
    // A navigation between two evaluations, or a document that changed
    // under the script: observe again.
    throw new StalePage(`Document changed during evaluation: ${(err as Error).message}`);
  }
}

/**
 * One observation. `afterInput` is the action just executed, when there was
 * one; its wait runs first and is read-only.
 */
export async function observe(page: Page, afterInput?: SnapshotAction): Promise<PageState> {
  if (afterInput && afterInput.kind !== 'wait' && afterInput.kind !== 'scroll') {
    try {
      await page.evaluate(afterInputScript(afterInput));
    } catch {
      // Read-only, and it happened after execution was recorded.
    }
  }
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      const info = await evaluateRaw<Omit<PageState, 'fingerprint'> | null>(page, SNAPSHOT_SCRIPT);
      if (info === null) throw new StalePage('Document is navigating');
      return { ...info, fingerprint: fingerprint(info) };
    } catch (err) {
      if (!(err instanceof StalePage) || attempt === 9) throw err;
      await new Promise((r) => setTimeout(r, 20));
    }
  }
  throw new StalePage('Page did not settle');
}

/** The page's visible text view, the same one read_active_browser_session
 *  gives: what the assistant answers from.
 *
 *  The files on the page are named in the text, because a <video> contributes
 *  no words of its own and a reader given only words concludes there is
 *  nothing there. A task that just spent two minutes making a clip ends with
 *  the page saying "your video is ready" and, without this, nothing to show
 *  for it. */
export function finalObservation(state: PageState): { url: string; title: string; text: string } {
  return {
    url: state.url,
    title: state.title,
    text: `${state.text}${filesBlock(state.media ?? [])}`,
  };
}
