// Whose run is this, and how do we know.

jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: jest.fn() }),
  pool: { query: jest.fn() },
}));

import { resolveAccountability } from '../service';

describe('resolveAccountability', () => {
  it('is the originator, precisely, when a person acted', () => {
    expect(resolveAccountability({ triggeredByUserId: 'account-1' })).toEqual({
      accountableUserId: 'account-1',
      attributionSource: 'direct_human',
    });
  });

  // A delegation changes who does the work, not who asked for it — so the child
  // is still attributed to a real person, and still precisely.
  it('calls an inherited human a delegation, not a fresh direct action', () => {
    expect(resolveAccountability({
      triggeredByUserId: 'account-1',
      parentInvocationId: 'parent-inv-1',
    })).toEqual({
      accountableUserId: 'account-1',
      attributionSource: 'delegation',
    });
  });

  it('says so plainly when there is no human', () => {
    expect(resolveAccountability({})).toEqual({
      accountableUserId: null,
      attributionSource: 'unattributed',
    });
  });

  // The one-way invariant, which a table CHECK also enforces: a derivation may
  // fill a hole and must never override someone who actually acted.
  it('never returns an accountable party who is not the originator', () => {
    for (const originator of ['account-1', 'slack:C01ABCD2EFG', undefined]) {
      const { accountableUserId } = resolveAccountability({
        triggeredByUserId: originator,
        parentInvocationId: 'parent-inv-1',
      });
      if (originator) expect(accountableUserId).toBe(originator);
      else expect(accountableUserId).toBeNull();
    }
  });
});

// The table states two rules. The one-way rule (originator ⇒ accountable) has a
// CHECK; so does this one — 'unattributed' means nobody was identified, so an id
// beside it is a contradiction, and any other source names someone, so a NULL id
// beside it is the opposite contradiction. The resolver is what must never
// produce either, because a row that violates it would be rejected outright and
// take the invocation down with it.
describe('resolveAccountability — the source and the id always agree', () => {
  const inputs: Array<Parameters<typeof resolveAccountability>[0]> = [
    {},
    { triggeredByUserId: 'account-1' },
    { parentInvocationId: 'parent-1' },
    { triggeredByUserId: 'account-1', parentInvocationId: 'parent-1' },
    { triggeredByUserId: 'slack:C01ABCD2EFG' },
  ];

  it.each(inputs)('holds for %j', (input) => {
    const { accountableUserId, attributionSource } = resolveAccountability(input);
    expect(attributionSource === 'unattributed').toBe(accountableUserId === null);
  });
});
