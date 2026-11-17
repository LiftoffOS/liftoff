// A wait returns when the page changes, not when a timer says so — and when it
// does not change, it says what the page was doing instead.
//
// The wait this replaces slept and returned a boolean. Three properties of it
// still have to hold, and they are kept here; what the verdicts MEAN is proven
// against a real browser in fence.browser.test.ts, because mutation and media
// state are behaviours of a real page.

jest.mock('../../../../infrastructure/logging', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { fence } from '../fence';
import type { PageState } from '../types';

const state = { marker: ['a'], page_key: 'k', guards: {} } as unknown as PageState;

/** A page whose marker becomes something else after `afterMs`. The progress
 *  read answers a page that is doing nothing, so a wait that finds no change
 *  lands on `quiet`. */
function pageThatChangesAfter(afterMs: number) {
  const startedAt = Date.now();
  return {
    evaluate: async (expression: unknown) => {
      if (typeof expression === 'string' && expression.includes('mutationsSeen')) {
        return { mutations: 0, sinceMs: -1, loading: false, mediaBusy: false };
      }
      return Date.now() - startedAt >= afterMs ? ['b'] : ['a'];
    },
  } as unknown as import('playwright-core').Page;
}

describe('fence', () => {
  it('returns as soon as the page changes, well inside the budget', async () => {
    const startedAt = Date.now();
    const verdict = await fence(pageThatChangesAfter(300), state, 10_000);
    expect(verdict).toBe('changed');
    expect(Date.now() - startedAt).toBeLessThan(3_000);
  });

  it('waits its whole budget when the page never changes, and names what it found', async () => {
    const startedAt = Date.now();
    const verdict = await fence(pageThatChangesAfter(60_000), state, 700);
    expect(verdict).toBe('quiet');
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(500);
  });

  // `fresh` turns a failed evaluation into StalePage, because the usual reason
  // a read fails mid-wait is that the document went away under it: a
  // navigation IS the change the wait is watching for. The cost of being wrong
  // is one more decision, on a fresh observation.
  it('a read that fails because the document moved counts as the page changing', async () => {
    const page = {
      evaluate: async (expression: unknown) => {
        if (typeof expression === 'string' && expression.includes('mutationsSeen')) return null;
        throw new Error('Execution context was destroyed');
      },
    } as unknown as import('playwright-core').Page;
    expect(await fence(page, state, 5_000)).toBe('changed');
  });

  // A page that cannot be read at all is a page doing something, not a page
  // that has settled: a document mid-navigation answers nothing.
  it('treats a page it cannot read as working rather than settled', async () => {
    const page = {
      evaluate: async (expression: unknown) => {
        if (typeof expression === 'string' && expression.includes('mutationsSeen')) throw new Error('no context');
        return ['a'];
      },
    } as unknown as import('playwright-core').Page;
    expect(await fence(page, state, 400)).toBe('working');
  });
});
