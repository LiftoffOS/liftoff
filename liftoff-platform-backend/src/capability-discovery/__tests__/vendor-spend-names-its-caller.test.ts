// A capability call says who ran it.
//
// `bookVendorSpend` wrote the `connector_call` row with no agent id and no
// purpose, so the Cost Breakdown had nowhere to put it and rendered it under
// "Unattributed": vendor spend from apify, locus, tikhub and vaaya calls,
// belonging to nobody.
//
// It was never unknowable. `caller` is on the input and is used to decide
// whether a write-class tool may execute, so the identity was already there,
// already load-bearing for something more important. And `purpose` is the SAME
// dimension the web-tool spend subscriber writes for browser sessions, which is
// exactly why an assistant's browser already appeared by name and its
// capability calls did not: one publisher set it, the other did not.
//
// This pins the mapping and the drop-through, because the failure was silent in
// both directions — a row with no attribution still bills correctly, so nothing
// broke, it just stopped being answerable.

import { surfaceForCaller as _surfaceForCaller } from '../vendor-execution';

// `surfaceForCaller` is module-private. Re-derived here from the exported
// behaviour would be a reimplementation of the thing under test (the trap the
// web-tool subscriber's own mock fell into), so it is exported for this.
const surfaceForCaller = _surfaceForCaller;

describe('which surface a capability call is booked to', () => {
  it('the Liftoff assistant books under the surface the ledger already knows', () => {
    // 'liftoff' is what billing/web-tool-spend-subscriber.ts writes for a
    // Liftoff browser session, and what insights/platform-assistants.ts maps
    // back to the name "Liftoff". Three places, one spelling.
    expect(surfaceForCaller('assistant')).toBe('liftoff');
  });

  it('the Chief AI Officer books under team_plan, its surface everywhere else', () => {
    expect(surfaceForCaller('caio')).toBe('team_plan');
  });

  it('an agent books under NO surface, because it is not one', () => {
    // The right answer for a team is its agent id. Inventing a surface here
    // would file a team's spend under a fictional assistant, which is worse
    // than reporting it unattributed: it would be wrong rather than unknown.
    expect(surfaceForCaller('agent')).toBeUndefined();
  });

  it('an absent caller books under no surface rather than guessing', () => {
    expect(surfaceForCaller(undefined)).toBeUndefined();
  });
});

describe('the surfaces match what reads them back', () => {
  it('every surface this produces resolves to an assistant on the page', async () => {
    // The Cost Breakdown groups agentless spend by `purpose`. A surface that
    // this writes but `assistantForPurpose` does not recognise would land the
    // spend right back in "Unattributed" — the defect surviving its own fix.
    const { assistantForPurpose } = await import('../../insights/platform-assistants');
    for (const caller of ['assistant', 'caio'] as const) {
      const surface = surfaceForCaller(caller);
      expect(surface).toBeDefined();
      expect(assistantForPurpose(surface!)).not.toBeNull();
    }
  });
});
