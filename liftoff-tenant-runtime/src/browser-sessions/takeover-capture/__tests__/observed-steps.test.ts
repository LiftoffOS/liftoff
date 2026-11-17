// A task's observed steps: how one observed action reads as a step, and how
// the observation is folded into a Stagehand-backed vendor's native list —
// ordering, no duplicate acts, retained extract and wait, the fallback for a
// step the observer missed, and the uncertainty that is reported rather than
// hidden.

import { observedActionPhrase, observedStepsFrom, reconcileTrail } from '../observed-steps';
import type { TakeoverActionRow } from '../action';
import type { BrowserTaskStep } from '../../../integrations/web-fetch/step-policy';

const row = (over: Partial<TakeoverActionRow>): TakeoverActionRow => ({
  nonce: 'n', seq: 0, kind: 'click', url: 'https://a.example/issues?q=browser', urlTruncated: false, urlProtectedDataOmitted: false,
  tag: 'button', role: 'button', name: 'Search', nameTruncated: false, nameProtectedDataOmitted: false, inputType: null,
  value: null, valueTruncated: false, valueDisposition: 'none', detail: null, detailTruncated: false, detailProtectedDataOmitted: false,
  ...over,
});

const at = (ms: number) => new Date(1_700_000_000_000 + ms);

describe('observedActionPhrase', () => {
  it.each([
    ['navigate', row({ kind: 'navigate', tag: null, role: null, name: null }), 'opened https://a.example/issues?q=browser'],
    ['click', row({ kind: 'click' }), 'clicked button "Search"'],
    ['click with coordinates', row({ kind: 'click', tag: 'canvas', role: '', name: null, detail: 'at 34%,58%' }), 'clicked an unnamed canvas (at 34%,58%)'],
    ['change with a recorded value', row({ kind: 'change', role: 'textbox', name: 'Search all issues', value: 'browser', valueDisposition: 'recorded' }), 'entered "browser" in textbox "Search all issues"'],
    ['change with an omitted authentication value', row({ kind: 'change', role: 'textbox', name: 'Password', valueDisposition: 'authentication_omitted' }), 'entered authentication data (not recorded) in textbox "Password"'],
    ['change with an omitted payment value', row({ kind: 'change', role: 'textbox', name: 'Card number', valueDisposition: 'payment_omitted' }), 'entered payment data (not recorded) in textbox "Card number"'],
    ['change with a file', row({ kind: 'change', role: '', tag: 'input', name: 'Attach', valueDisposition: 'file_omitted' }), 'entered a file (not recorded) in input "Attach"'],
    ['change with credential-shaped text', row({ kind: 'change', role: 'textbox', name: 'Notes', valueDisposition: 'sensitive_text_omitted' }), 'entered sensitive credential-shaped text (not recorded) in textbox "Notes"'],
    ['enter', row({ kind: 'enter', role: 'textbox', name: 'Search all issues', value: 'browser', valueDisposition: 'recorded' }), 'pressed Enter in textbox "Search all issues" ("browser")'],
    ['submit', row({ kind: 'submit', tag: 'form', role: 'form', name: 'Checkout' }), 'submitted form "Checkout"'],
    ['key', row({ kind: 'key', role: 'textbox', name: 'Body', detail: 'Control+Enter' }), 'pressed Control+Enter in textbox "Body"'],
    ['scroll', row({ kind: 'scroll', tag: null, role: null, name: null, detail: 'scroll down to 0%,42%' }), 'scroll down to 0%,42%'],
    ['drag', row({ kind: 'drag', role: 'listitem', name: 'Done', detail: 'from listitem "Card 4"' }), 'dragged from listitem "Card 4" to listitem "Done"'],
    ['contextmenu', row({ kind: 'contextmenu', role: 'link', name: 'Commits' }), 'opened the context menu on link "Commits"'],
    ['hover', row({ kind: 'hover', role: 'link', name: 'Pull requests' }), 'hovered over link "Pull requests"'],
  ])('%s', (_label, r, expected) => {
    expect(observedActionPhrase(r)).toBe(expected);
  });
});

describe('observedStepsFrom', () => {
  it('carries the flags and the time, and names the omitted class', () => {
    const steps = observedStepsFrom([
      { row: row({ kind: 'change', valueDisposition: 'payment_omitted', urlProtectedDataOmitted: true, nameTruncated: true }), at: at(10) },
      { row: row({ kind: 'click', detailTruncated: true, detailProtectedDataOmitted: true }), at: at(20) },
    ]);
    expect(steps[0]).toMatchObject({
      type: 'change', protectedDataOmitted: true, protectedKind: 'payment', pageUrlProtectedDataOmitted: true, actionTruncated: true, at: at(10),
    });
    expect(steps[1]).toMatchObject({ type: 'click', protectedDataOmitted: true, protectedKind: '', actionTruncated: true, at: at(20) });
  });
});

const native = (type: string, action: string): BrowserTaskStep => ({
  type, action, pageUrl: 'https://a.example/', actionTruncated: false, pageUrlTruncated: false,
  protectedDataOmitted: false, protectedKind: '', pageUrlProtectedDataOmitted: false, at: null,
});
const ok = { captureGap: false, gapReason: null, stepsTruncated: false } as const;

describe('reconcileTrail', () => {
  it('with no native list (Anchor) the observed steps stand alone, with the capture\'s own gap', () => {
    const observed = observedStepsFrom([{ row: row({ kind: 'click' }), at: at(1) }]);
    expect(reconcileTrail(null, observed, ok)).toEqual({ steps: observed, captureGap: false, gapReason: null, stepsTruncated: false });
    expect(reconcileTrail(null, observed, { captureGap: true, gapReason: 'attach_failed', stepsTruncated: false }))
      .toMatchObject({ captureGap: true, gapReason: 'attach_failed' });
  });

  it('collapses act, fillForm, goto and scroll onto the observed steps that represent them, in order, with no duplicate acts', () => {
    const observed = observedStepsFrom([
      { row: row({ kind: 'navigate', tag: null, role: null, name: null }), at: at(1) },
      { row: row({ kind: 'change', role: 'textbox', name: 'Search', value: 'browser', valueDisposition: 'recorded' }), at: at(2) },
      { row: row({ kind: 'enter', role: 'textbox', name: 'Search', value: 'browser', valueDisposition: 'recorded' }), at: at(3) },
      { row: row({ kind: 'click', name: 'Pull requests' }), at: at(4) },
      { row: row({ kind: 'scroll', detail: 'scroll down to 0%,80%' }), at: at(5) },
    ]);
    const out = reconcileTrail([
      native('goto', 'https://a.example/'),
      native('fillForm', 'fill the search box "browser"'),
      native('act', 'press · the search box · Enter'),
      native('act', 'click · Pull requests'),
      native('scroll', 'scroll down'),
      native('extract', 'read the count'),
    ], observed, ok);
    expect(out.steps.map((s) => `${s.type}:${s.action}`)).toEqual([
      'navigate:opened https://a.example/issues?q=browser',
      'change:entered "browser" in textbox "Search"',
      'enter:pressed Enter in textbox "Search" ("browser")',
      'click:clicked button "Pull requests"',
      'scroll:scroll down to 0%,80%',
      'extract:read the count',
    ]);
    expect(out).toMatchObject({ captureGap: false, gapReason: null });
  });

  it('retains extract, wait, screenshot, ariaTree, navback and close in their original place', () => {
    const observed = observedStepsFrom([{ row: row({ kind: 'click' }), at: at(1) }, { row: row({ kind: 'click', name: 'Next' }), at: at(2) }]);
    const out = reconcileTrail([
      native('act', 'click · Search'), native('extract', 'read'), native('wait', 'wait 500ms'), native('screenshot', 'screenshot'),
      native('act', 'click · Next'), native('close', 'close'),
    ], observed, ok);
    expect(out.steps.map((s) => s.type)).toEqual(['click', 'extract', 'wait', 'screenshot', 'click', 'close']);
  });

  it('keeps the sanitized native fallback for a step the observer missed, and reports uncertainty when a counterpart still waits further on', () => {
    // Two native acts, one observed click: the first act is unmatched while a
    // click is still waiting, so the alignment could be wrong either way.
    const observed = observedStepsFrom([{ row: row({ kind: 'click', name: 'Next' }), at: at(1) }]);
    const both = reconcileTrail([native('act', 'click · Search'), native('act', 'click · Next')], observed, ok);
    expect(both.steps.map((s) => s.action)).toEqual(['clicked button "Next"', 'click · Next']);
    expect(both).toMatchObject({ captureGap: true, gapReason: 'reconciliation_uncertain' });

    // A loop that reports DOM actions of which the observer saw NOTHING: the
    // fallback stands, and the trail fails closed as a gap, since the
    // events may not have reached the isolated world as trusted.
    const alone = reconcileTrail([native('act', 'click · Search')], [], ok);
    expect(alone.steps.map((s) => s.action)).toEqual(['click · Search']);
    expect(alone).toMatchObject({ captureGap: true, gapReason: 'reconciliation_uncertain' });
    // A loop with no DOM action at all (an extract on the open page) needs
    // no observation and reports no gap.
    const nothingToObserve = reconcileTrail([native('extract', 'extract · the price')], [], ok);
    expect(nothingToObserve.captureGap).toBe(false);
    // One miss beside a match is the fallback alone, without a gap.
    const observed2 = observedStepsFrom([{ row: row({ kind: 'click', name: 'Search' }), at: at(1) }]);
    const oneMiss = reconcileTrail([native('act', 'click · Search'), native('act', 'click · Next')], observed2, ok);
    expect(oneMiss.steps.map((s) => s.action)).toEqual(['clicked button "Search"', 'click · Next']);
    expect(oneMiss.captureGap).toBe(false);
  });

  it('an observed step nothing native explains (a page-level hover) is kept where it happened', () => {
    const observed = observedStepsFrom([
      { row: row({ kind: 'hover', role: 'link', name: 'Commits' }), at: at(1) },
      { row: row({ kind: 'click', name: 'Commits' }), at: at(2) },
    ]);
    const out = reconcileTrail([native('act', 'click · Commits')], observed, ok);
    expect(out.steps.map((s) => s.type)).toEqual(['hover', 'click']);
  });

  it('the capture\'s cap is the trail\'s stepsTruncated and gap', () => {
    const out = reconcileTrail([native('close', 'close')], [], { captureGap: true, gapReason: 'cap', stepsTruncated: true });
    expect(out).toMatchObject({ captureGap: true, gapReason: 'cap', stepsTruncated: true });
  });
});
