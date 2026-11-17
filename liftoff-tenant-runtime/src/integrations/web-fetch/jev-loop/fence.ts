// Whether the page is still working, or just not changing.
//
// The loop's wait answered a boolean: did the page change. That cannot tell a
// render in progress from a dead end, and those need opposite responses. A
// generator that takes two minutes wants to be left alone; a page that will
// never change wants the task to stop waiting and do something else. Answered
// as one bit, both look identical — nothing changed — so the loop spent its
// wait ladder on a working page and then called it unsettled, or kept clicking
// at a page that was busy.
//
// So the wait answers with a NAMED verdict, and `working` is a first-class one
// rather than a failure. Three signals decide it, none of them a guess about
// the site:
//
//   mutations   the page is altering its own DOM, and how long since it last did
//   media       an element on the page is loading a file, or has none yet
//   navigation  a navigation is in flight
//
// This is the piece the ten-minute run lacked. It could not tell "still
// rendering" from "I cannot tell", so it did the only thing a boolean allows
// and waited, then reported nothing.

import type { Page } from 'playwright-core';
import { JEV_GLOBAL } from './snapshot';
import { fresh, WAIT_POLL_MS } from './act';
import { StalePage } from './observe';
import type { PageState } from './types';

/**
 * What the wait found.
 *
 *  - `changed`   the page is no longer the one the decision was made on.
 *  - `working`   it has not changed yet AND is visibly busy: mutating, loading
 *                a file, or navigating. Waiting longer is the right move and
 *                costs the loop nothing but time it was going to spend.
 *  - `ambiguous` it is mutating without any of that meaning anything — a
 *                spinner, a clock, an animation. Worth saying rather than
 *                calling the page settled.
 *  - `quiet`     nothing is happening at all. The page is not going to change
 *                by being waited on.
 */
export type FenceVerdict = 'changed' | 'working' | 'ambiguous' | 'quiet';

/** Silence long enough to mean the page has stopped rather than paused between
 *  frames. A render loop paints far more often than this. */
const QUIET_MS = 600;

/**
 * What the page is doing, read in one evaluate.
 *
 * The mutation recorder is installed on the snapshot's own cache, so it
 * survives between observations and is created at most once per document.
 */
const PROGRESS_SCRIPT = `(() => {
  const c = window.${JEV_GLOBAL} ||= {ids:new WeakMap(), nodes:new Map(), next:1};
  if (!c.mutationsSeen) {
    c.mutationsSeen = 0;
    c.lastMutationAt = 0;
    try {
      new MutationObserver((records) => {
        c.mutationsSeen += records.length;
        c.lastMutationAt = Date.now();
      }).observe(document.documentElement, {subtree:true, childList:true, attributes:true, characterData:true});
    } catch (e) { /* a document that cannot be observed reports no mutations */ }
  }
  let mediaBusy = false;
  for (const el of document.querySelectorAll('video,audio')) {
    // NETWORK_LOADING, or an element with a source that has no data yet: a
    // file on its way. HAVE_NOTHING with no source at all is an empty player,
    // which is not busy.
    const hasSrc = Boolean(el.currentSrc || el.getAttribute('src') || el.querySelector('source'));
    if (el.networkState === 2 || (hasSrc && el.readyState === 0)) { mediaBusy = true; break; }
  }
  return {
    mutations: c.mutationsSeen,
    sinceMs: c.lastMutationAt ? Date.now() - c.lastMutationAt : -1,
    loading: document.readyState !== 'complete',
    mediaBusy,
  };
})()`;

interface Progress {
  mutations: number;
  /** Milliseconds since the last DOM mutation; -1 when there has been none. */
  sinceMs: number;
  loading: boolean;
  mediaBusy: boolean;
}

async function progressOf(page: Page): Promise<Progress | null> {
  try {
    return await page.evaluate(PROGRESS_SCRIPT) as Progress;
  } catch {
    // A document mid-navigation cannot be read. That is itself a page doing
    // something, and the caller's marker read will say so.
    return null;
  }
}

/**
 * Wait for the page to stop being the one the decision was made on, and say
 * what was found if it does not.
 *
 * Polls the same full-page marker `fresh` compares, so "changed" means here
 * what it means everywhere else in the loop.
 */
export async function fence(page: Page, state: PageState, budgetMs: number): Promise<FenceVerdict> {
  const until = Date.now() + Math.max(0, budgetMs);
  const before = await progressOf(page);
  let mutatedWhileWaiting = false;
  for (;;) {
    await new Promise((r) => setTimeout(r, WAIT_POLL_MS));
    try {
      if (!(await fresh(page, state))) return 'changed';
    } catch (err) {
      // A page that moved under the read has changed by definition.
      if (err instanceof StalePage) return 'changed';
    }
    const now = await progressOf(page);
    if (now && before && now.mutations > before.mutations) mutatedWhileWaiting = true;
    if (Date.now() < until) continue;

    // The budget is spent. What was the page doing while it was?
    if (!now) return 'working';
    if (now.loading || now.mediaBusy) return 'working';
    if (now.sinceMs >= 0 && now.sinceMs < QUIET_MS) return 'working';
    if (mutatedWhileWaiting) return 'ambiguous';
    return 'quiet';
  }
}
