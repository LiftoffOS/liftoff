// The override merge, which is the ADR-043 discipline applied to configuration.
//
// A redistill REPLACES what the last distillation wrote and leaves everything
// else alone. Without that it is a rewrite, and what it rewrites away is
// whatever a human put there.
//
// The wire shape is a flat {toolName: text} map with no room for a per-entry
// provenance marker, so the marker lives in the decision record. That is the
// only thing making this a merge rather than a replace, and it is why the
// third case below is the one that matters.

import { mergeToolDescriptionOverrides, distilledOverrideTools } from '../tool-override-provenance';

describe('mergeToolDescriptionOverrides', () => {
  it('takes the incoming text where this run named the tool', () => {
    const r = mergeToolDescriptionOverrides({ a: 'old' }, { a: 'new' }, ['a']);
    expect(r.merged).toEqual({ a: 'new' });
  });

  it('retires an override the PREVIOUS distillation wrote and this one did not', () => {
    // Keeping it would apply a retired policy forever — the failure
    // resultRules' full-list replace exists to avoid.
    const r = mergeToolDescriptionOverrides({ a: 'old' }, {}, ['a']);
    expect(r.merged).toEqual({});
    expect(r.retired).toEqual(['a']);
  });

  it('PRESERVES an override no distillation wrote', () => {
    // The case the whole mechanism is for. Nobody's distillation authored it,
    // so a human did, and a redistill has no business deleting it.
    const r = mergeToolDescriptionOverrides({ human: 'hand-written' }, { a: 'new' }, ['a']);
    expect(r.merged).toEqual({ human: 'hand-written', a: 'new' });
    expect(r.preserved).toEqual(['human']);
  });

  it('preserves everything when the record says nothing', () => {
    // A legacy row, or the first distillation after the column existed. The
    // cost of keeping a stale distilled override is a rule that no longer
    // applies; the cost of dropping a human's is silent data loss. Only one of
    // those is recoverable by reading the agent.
    const r = mergeToolDescriptionOverrides({ a: 'old', b: 'old' }, {}, undefined);
    expect(r.merged).toEqual({ a: 'old', b: 'old' });
    expect(r.retired).toEqual([]);
  });

  it('records what THIS run authored, for the next merge', () => {
    const r = mergeToolDescriptionOverrides({}, { b: 'x', a: 'y' }, []);
    expect(r.distilledTools).toEqual(['a', 'b']);
  });

  it('lets an incoming override win over a preserved human one it names', () => {
    // Not a contradiction of the preserve rule: this run reasoned about the
    // tool and said something. Preservation covers absence, not disagreement.
    const r = mergeToolDescriptionOverrides({ a: 'human' }, { a: 'distilled' }, []);
    expect(r.merged).toEqual({ a: 'distilled' });
    expect(r.preserved).toEqual([]);
  });

  it('handles both sides absent', () => {
    expect(mergeToolDescriptionOverrides(undefined, undefined, undefined).merged).toEqual({});
  });
});

describe('distilledOverrideTools', () => {
  it('reads the marker off the record, empty when absent', () => {
    expect(distilledOverrideTools({ distilledOverrideTools: ['a'] })).toEqual(['a']);
    expect(distilledOverrideTools({})).toEqual([]);
    expect(distilledOverrideTools(undefined)).toEqual([]);
  });
});
