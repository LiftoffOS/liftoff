// Approve-with-edits: the reviewer's version is what gets dispatched.
//
// The gate could only say yes or no to the call as proposed. These pin the
// third thing a reviewer can now do — rewrite it and say yes — and in
// particular the two ways that goes wrong silently: an edit accepted by every
// layer and applied by none, and a merge that cannot express a removal.

import {
  applyApprovedEdits,
  editedCallIds,
  parseApprovedEdits,
} from '../approved-edits';

const CALLS = [
  { id: 'tc-1', name: 'gmail__send', input: { to: ['a@x.com', 'b@x.com'], body: 'agent draft' } },
  { id: 'tc-2', name: 'slack__post', input: { channel: 'C1', text: 'hello' } },
];

describe('applyApprovedEdits', () => {
  it('leaves every call alone when nothing was edited', () => {
    expect(applyApprovedEdits(CALLS, undefined)).toEqual(CALLS);
    expect(applyApprovedEdits(CALLS, {})).toEqual(CALLS);
  });

  it('replaces the input of the call the reviewer edited', () => {
    const out = applyApprovedEdits(CALLS, { 'tc-1': { to: ['a@x.com'], body: 'their wording' } });
    expect(out[0].input).toEqual({ to: ['a@x.com'], body: 'their wording' });
  });

  it('leaves the calls the reviewer did not touch', () => {
    const out = applyApprovedEdits(CALLS, { 'tc-1': { body: 'x' } });
    expect(out[1]).toBe(CALLS[1]);
  });

  it('replaces rather than merges, so a removal is a removal', () => {
    // The edit that matters most is often taking something OUT: a recipient off
    // a thread, a paragraph cut, an attachment dropped. A merge would keep the
    // original `to` and the reviewer's removal would silently not happen.
    const out = applyApprovedEdits(CALLS, { 'tc-1': { to: ['a@x.com'] } });
    expect(out[0].input).toEqual({ to: ['a@x.com'] });
    expect(out[0].input).not.toHaveProperty('body');
  });

  it('keeps the call id and name, which the reviewer never edits', () => {
    const out = applyApprovedEdits(CALLS, { 'tc-1': { body: 'x' } });
    expect(out[0].id).toBe('tc-1');
    expect(out[0].name).toBe('gmail__send');
  });

  it('drops an edit keyed to no pending call rather than dispatching one', () => {
    const out = applyApprovedEdits(CALLS, { 'tc-99': { body: 'from nowhere' } });
    expect(out).toEqual(CALLS);
  });

  it('does not mutate the calls it was given', () => {
    const before = JSON.stringify(CALLS);
    applyApprovedEdits(CALLS, { 'tc-1': { body: 'changed' } });
    expect(JSON.stringify(CALLS)).toBe(before);
  });
});

describe('editedCallIds', () => {
  it('reports the calls whose arguments actually changed', () => {
    expect(editedCallIds(CALLS, { 'tc-1': { to: ['a@x.com'], body: 'new' } })).toEqual(['tc-1']);
  });

  it('reports nothing when the reviewer opened the editor and changed nothing', () => {
    // Approving an unchanged draft is an approval. Logging it as an override
    // would misreport what the review found.
    expect(editedCallIds(CALLS, { 'tc-1': { to: ['a@x.com', 'b@x.com'], body: 'agent draft' } }))
      .toEqual([]);
  });

  it('ignores key order, which an editor is free to change', () => {
    expect(editedCallIds(CALLS, { 'tc-2': { text: 'hello', channel: 'C1' } })).toEqual([]);
  });

  it('is empty when there were no edits at all', () => {
    expect(editedCallIds(CALLS, null)).toEqual([]);
  });
});

describe('parseApprovedEdits', () => {
  it('accepts a map of tool call id to input object', () => {
    expect(parseApprovedEdits({ 'tc-1': { body: 'x' } })).toEqual({ 'tc-1': { body: 'x' } });
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an array', [{ body: 'x' }]],
    ['a string', 'tc-1'],
    ['an empty map', {}],
  ])('returns undefined for %s', (_label, value) => {
    expect(parseApprovedEdits(value)).toBeUndefined();
  });

  it('drops an entry whose value is not an input object', () => {
    // JSONB would happily store a string here and it would fail much later, at
    // dispatch, with nothing left to point at.
    expect(parseApprovedEdits({ 'tc-1': 'not an input', 'tc-2': { text: 'ok' } }))
      .toEqual({ 'tc-2': { text: 'ok' } });
  });

  it('returns undefined when every entry was dropped', () => {
    expect(parseApprovedEdits({ 'tc-1': 'nope' })).toBeUndefined();
  });
});
