// Making the runtime agree with the column.
//
// The narrowing is the only decision this script makes, so it is the only thing
// worth testing: a publish is a real event with real subscribers, and
// re-emitting one for every agent in the fleet to correct a handful is the kind
// of well-meant sweep that fills a queue.

import { needsConvergence } from '../../scripts/converge-runtime-skill-provenance';

describe('which agents need a publish', () => {
  it('skips an agent whose skills are all plain distilled output', () => {
    // The runtime's defaults already agree with the column for these.
    expect(needsConvergence([
      { name: 'a', provenance: 'distilled' },
      { name: 'b', provenance: 'distilled' },
    ])).toBe(false);
  });

  it('catches a learned skill, which the runtime defaulted to distilled', () => {
    // The case the whole script exists for: migration 334 defaulted every
    // pre-existing row, and nothing has corrected them since.
    expect(needsConvergence([{ name: 'a', provenance: 'learned' }])).toBe(true);
  });

  it('catches an operator skill', () => {
    expect(needsConvergence([{ name: 'a', provenance: 'operator' }])).toBe(true);
  });

  it('catches a protected skill, which the runtime defaulted to unprotected', () => {
    // Same migration, same shape: `protected` defaulted to false over skills an
    // operator had taken ownership of.
    expect(needsConvergence([{ name: 'a', provenance: 'distilled', protected: true }])).toBe(true);
  });

  it('catches an archived skill', () => {
    expect(needsConvergence([{ name: 'a', provenance: 'distilled', archived: true }])).toBe(true);
  });

  it('catches one drifted skill among many that agree', () => {
    expect(needsConvergence([
      { name: 'a', provenance: 'distilled' },
      { name: 'b', provenance: 'learned' },
      { name: 'c', provenance: 'distilled' },
    ])).toBe(true);
  });

  it('skips an agent with no skills at all', () => {
    expect(needsConvergence([])).toBe(false);
  });
});
