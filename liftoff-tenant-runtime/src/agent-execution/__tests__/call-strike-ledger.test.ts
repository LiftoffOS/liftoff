// The strike ledger's two rules, and the orderings that used to break them.
//
// The scenario this exists for: four parallel calls in one model turn, all
// rejected for the same malformed argument, escalated a run at the second
// rejection — 44 ms after the first, before any correction had been delivered.
// A strike is a repeat of the SAME call, and a model turn is ONE decision;
// both are asserted here directly, along with the orderings a boundary
// consumed late can produce.

import { CallStrikeLedger, callSignature } from '../call-strike-ledger';

describe('callSignature', () => {
  it('keys on the tool and the canonical arguments', () => {
    expect(callSignature('web_fetch', { url: 'https://a' }))
      .not.toBe(callSignature('web_fetch', { url: 'https://b' }));
    expect(callSignature('web_fetch', { url: 'https://a' }))
      .not.toBe(callSignature('web_research', { url: 'https://a' }));
  });

  it('does not change with argument key order', () => {
    expect(callSignature('t', { a: 1, b: { c: 2, d: 3 } }))
      .toBe(callSignature('t', { b: { d: 3, c: 2 }, a: 1 }));
  });

  it('treats a missing tool name and missing arguments as stable keys', () => {
    expect(callSignature(undefined, undefined)).toBe(callSignature(undefined, {}));
    expect(callSignature(undefined, undefined)).toContain('unknown_tool');
  });
});

describe('CallStrikeLedger — identified batches', () => {
  const same = callSignature('web_research', { query: 'x' });

  it('folds parallel rejections of one call into one strike, and corrects once', () => {
    const ledger = new CallStrikeLedger(true);
    expect(ledger.reject({ key: same, callId: 'a', kind: 'malformed' }))
      .toEqual({ firstInBatch: true, strikes: null });
    expect(ledger.reject({ key: same, callId: 'b', kind: 'malformed' }))
      .toEqual({ firstInBatch: false, strikes: null });
    expect(ledger.reject({ key: same, callId: 'c', kind: 'malformed' }))
      .toEqual({ firstInBatch: false, strikes: null });
    const folded = ledger.close(['a', 'b', 'c']);
    expect(folded).toEqual([{ key: same, kind: 'malformed', strikes: 1, detail: undefined }]);
    expect(ledger.openCount).toBe(0);
  });

  it('counts the same call in two consecutive batches as two strikes', () => {
    const ledger = new CallStrikeLedger(true);
    ledger.reject({ key: same, callId: 'a', kind: 'malformed' });
    expect(ledger.close(['a'])[0].strikes).toBe(1);
    expect(ledger.reject({ key: same, callId: 'b', kind: 'malformed' }).firstInBatch).toBe(true);
    expect(ledger.close(['b'])[0].strikes).toBe(2);
  });

  it('keeps two different calls to one tool apart', () => {
    const ledger = new CallStrikeLedger(true);
    const a = callSignature('web_fetch', { url: 'https://a' });
    const b = callSignature('web_fetch', { url: 'https://b' });
    ledger.reject({ key: a, callId: '1', kind: 'permanent', detail: 'not_found' });
    ledger.close(['1']);
    ledger.reject({ key: b, callId: '2', kind: 'permanent', detail: 'not_found' });
    const folded = ledger.close(['2']);
    expect(folded).toEqual([{ key: b, kind: 'permanent', strikes: 1, detail: 'not_found' }]);
  });

  it('a close naming ids with no open entry folds nothing', () => {
    const ledger = new CallStrikeLedger(true);
    ledger.reject({ key: same, callId: 'a', kind: 'malformed' });
    expect(ledger.close(['x', 'y'])).toEqual([]);
    expect(ledger.openCount).toBe(1);
  });

  it('a stale boundary landing between two parallel rejections cannot split them', () => {
    // The ordering the assistant_message reset would have produced: first
    // rejection, then a boundary from an EARLIER batch consumed late, then the
    // second rejection of the same call. Because the stale boundary names
    // ids that are not open, it folds nothing, and the two rejections still
    // become one strike when their own boundary arrives.
    const ledger = new CallStrikeLedger(true);
    ledger.reject({ key: same, callId: 'a', kind: 'malformed' });
    expect(ledger.close(['stale-1', 'stale-2'])).toEqual([]);
    expect(ledger.reject({ key: same, callId: 'b', kind: 'malformed' }).firstInBatch).toBe(false);
    const folded = ledger.close(['a', 'b']);
    expect(folded.map((f) => f.strikes)).toEqual([1]);
  });

  it('a boundary consumed late merges two batches rather than splitting one', () => {
    // Batch 1 rejects the call; its boundary has not been consumed yet when
    // batch 2 rejects the same call. Both fold together: one strike, which
    // delays the cap by a batch. That is the safe direction.
    const ledger = new CallStrikeLedger(true);
    ledger.reject({ key: same, callId: 'a', kind: 'malformed' });
    ledger.reject({ key: same, callId: 'b', kind: 'malformed' });
    expect(ledger.close(['a']).map((f) => f.strikes)).toEqual([1]);
    expect(ledger.close(['b'])).toEqual([]);
  });

  it('an entry with no call id folds on any close', () => {
    const ledger = new CallStrikeLedger(true);
    ledger.reject({ key: same, kind: 'permanent' });
    expect(ledger.close(['unrelated']).map((f) => f.strikes)).toEqual([1]);
  });

  it('recovery entries are folded but carry no cap', () => {
    const ledger = new CallStrikeLedger(true);
    expect(ledger.reject({ key: 'tool', callId: 'a', kind: 'recovery' }).firstInBatch).toBe(true);
    expect(ledger.reject({ key: 'tool', callId: 'b', kind: 'recovery' }).firstInBatch).toBe(false);
    expect(ledger.close(['a', 'b'])).toEqual([{ key: 'tool', kind: 'recovery', strikes: 1, detail: undefined }]);
  });
});

describe('CallStrikeLedger — per-call mode (engines without a call id)', () => {
  const same = callSignature('search', {});

  it('folds every rejection immediately and reports the running count', () => {
    const ledger = new CallStrikeLedger(false);
    expect(ledger.reject({ key: same, kind: 'permanent' })).toEqual({ firstInBatch: true, strikes: 1 });
    expect(ledger.reject({ key: same, kind: 'permanent' })).toEqual({ firstInBatch: true, strikes: 2 });
    expect(ledger.openCount).toBe(0);
  });

  it('still keeps different calls apart', () => {
    const ledger = new CallStrikeLedger(false);
    ledger.reject({ key: callSignature('search', { q: 'a' }), kind: 'permanent' });
    expect(ledger.reject({ key: callSignature('search', { q: 'b' }), kind: 'permanent' }).strikes).toBe(1);
  });
});

describe('a tool that refuses every call is a broken tool', () => {
  // Rule 1 keys a strike on the CALL, and is right to: two missing pages are
  // two facts about two pages. The blind spot is the opposite case. A live run
  // called web_finance_search twelve times over six different queries; every
  // call came back with the same code, no argument set repeated, so six keys
  // each reached one strike against a cap of two and the run spent its whole
  // wall clock being told to find another angle that did not exist.
  const perCall = (tool: string, args: unknown) => callSignature(tool, args);

  it('counts DISTINCT calls per (tool, code)', () => {
    const l = new CallStrikeLedger(false);
    for (const q of ['AAPL', 'MSFT', 'NVDA']) {
      l.reject({ key: perCall('web_finance_search', { query: q }), kind: 'permanent', detail: 'internal_error' });
    }
    expect(l.distinctPermanentFailures('web_finance_search', 'internal_error')).toBe(3);
  });

  it('counts the same call twice as one distinct call', () => {
    // The repeat is rule 1's business and must not also inflate this one.
    const l = new CallStrikeLedger(false);
    const key = perCall('web_finance_search', { query: 'AAPL' });
    l.reject({ key, kind: 'permanent', detail: 'internal_error' });
    l.reject({ key, kind: 'permanent', detail: 'internal_error' });
    expect(l.distinctPermanentFailures('web_finance_search', 'internal_error')).toBe(1);
  });

  it('does not pool two different codes', () => {
    // Three not_founds and a rate limit are not four facts about one tool.
    const l = new CallStrikeLedger(false);
    l.reject({ key: perCall('web_fetch_advanced', { url: 'a' }), kind: 'permanent', detail: 'not_found' });
    l.reject({ key: perCall('web_fetch_advanced', { url: 'b' }), kind: 'permanent', detail: 'invalid_arguments' });
    expect(l.distinctPermanentFailures('web_fetch_advanced', 'not_found')).toBe(1);
    expect(l.distinctPermanentFailures('web_fetch_advanced', 'invalid_arguments')).toBe(1);
  });

  it('does not pool two different tools', () => {
    const l = new CallStrikeLedger(false);
    l.reject({ key: perCall('web_finance_search', { query: 'a' }), kind: 'permanent', detail: 'internal_error' });
    l.reject({ key: perCall('web_people_search', { query: 'a' }), kind: 'permanent', detail: 'internal_error' });
    expect(l.distinctPermanentFailures('web_finance_search', 'internal_error')).toBe(1);
  });

  it('counts a malformed rejection toward nothing here', () => {
    // Malformed arguments ARE the model's to fix and say nothing about the tool.
    const l = new CallStrikeLedger(false);
    l.reject({ key: perCall('web_finance_search', { query: 'a' }), kind: 'malformed', detail: 'invalid_arguments' });
    expect(l.distinctPermanentFailures('web_finance_search', 'invalid_arguments')).toBe(0);
  });

  it('counts nothing while the batch is still open', () => {
    // On an engine that names its batches, a model turn is one decision and has
    // not been answered yet. Counting here would condemn a tool before the
    // first correction was delivered.
    const l = new CallStrikeLedger(true);
    for (const q of ['a', 'b', 'c']) {
      l.reject({ key: perCall('web_finance_search', { query: q }), callId: `c-${q}`, kind: 'permanent', detail: 'internal_error' });
    }
    expect(l.distinctPermanentFailures('web_finance_search', 'internal_error')).toBe(0);
    l.close(['c-a', 'c-b', 'c-c']);
    expect(l.distinctPermanentFailures('web_finance_search', 'internal_error')).toBe(3);
  });

  it('is zero for a tool that never failed', () => {
    expect(new CallStrikeLedger(false).distinctPermanentFailures('web_search', 'internal_error')).toBe(0);
  });
});
