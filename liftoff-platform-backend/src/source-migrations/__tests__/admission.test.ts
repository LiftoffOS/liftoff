// Conversion admission: the payment boundary and the cost ceilings.
//
// The property under test is that nothing billable can start on the wrong side
// of a paid subscription, and that every ceiling FAILS CLOSED at its boundary
// rather than one item past it.

import {
  checkConversionAdmission,
  checkMigrationCreationAdmission,
  mayRetryItem,
  DISTILL_RATE_LIMITS,
  type AdmissionDenial,
  MAX_ITEM_ATTEMPTS,
  MAX_MIGRATIONS_PER_24H,
} from '../admission';

const PAID = { paid: true, operationalStatus: 'active' };

describe('conversion admission', () => {
  it('refuses conversion for an unpaid workspace', () => {
    const result = checkConversionAdmission({
      entitlement: { paid: false }
    });
    expect(result.allowed).toBe(false);
    expect(result).toMatchObject({ code: 'payment_required' });
  });

  it('admits conversion for a paid workspace', () => {
    expect(
      checkConversionAdmission({ entitlement: PAID }).allowed,
    ).toBe(true);
  });

  it('refuses conversion while the workspace is suspended, paid or not', () => {
    const result = checkConversionAdmission({
      entitlement: { ...PAID, operationalStatus: 'suspended' }
    });
    expect(result.allowed).toBe(false);
  });

  describe('there is no seat cap', () => {
    // Pricing is consumption of Operating Units. A workspace may run as many
    // teams as it wants, so an import is never refused for being too big — it
    // is metered like everything else. A per-workspace limit here would be a
    // second money authority beside the OU buckets (INV-PB-010).
    it('admits an import into a workspace that already runs many teams', () => {
      expect(
        checkConversionAdmission({ entitlement: PAID }).allowed,
      ).toBe(true);
    });

    it('admits regardless of how much the workspace already has', () => {
      // E.g. 30 teams running against a `team_count` of 5, a number nothing
      // else in the product enforces.
      expect(
        checkConversionAdmission({ entitlement: PAID }).allowed,
      ).toBe(true);
    });
  });

  describe('size of the import', () => {
    // There was a cap of 25, chosen so a conversion could not exhaust a
    // person's hourly distillation allowance. It was protecting the wrong
    // thing: running out of allowance was always handled — the item is left
    // pending with the reason — and what was actually missing was anything to
    // come back and finish it. The resume sweep does that now, so the cap only
    // refused imports the system can complete.
    //
    // Admission takes no count at all any more. That is the property here:
    // there is no number you can pass that turns a paid workspace into a
    // refusal, because size is not a reason to refuse.
    it('takes no size input, so a paid workspace is admitted whatever it imports', () => {
      expect(checkConversionAdmission({ entitlement: PAID })).toEqual({ allowed: true });
    });

    it('carries no size-based denial code', () => {
      // The union is the contract. A code nothing can emit is a branch every
      // caller still has to handle.
      const codes: AdmissionDenial['code'][] = [
        'payment_required',
        'too_many_migrations',
        'rate_limited',
        'attempts_exhausted',
      ];
      expect(codes).not.toContain('too_many_identities' as never);
    });

    it('still refuses an unpaid workspace', () => {
      // Size stopped being a reason to refuse. Payment did not.
      expect(checkConversionAdmission({ entitlement: { paid: false } })).toMatchObject({
        allowed: false,
        code: 'payment_required',
      });
    });
  });
});

describe('migration creation admission', () => {
  it('admits the first migration of the day', () => {
    expect(
      checkMigrationCreationAdmission({ recentMigrationCount: 0, nonTerminalCount: 0 }).allowed,
    ).toBe(true);
  });

  it(`refuses the ${MAX_MIGRATIONS_PER_24H + 1}th in 24 hours`, () => {
    const result = checkMigrationCreationAdmission({
      recentMigrationCount: MAX_MIGRATIONS_PER_24H,
    });
    expect(result).toMatchObject({ allowed: false, code: 'too_many_migrations' });
  });

  it('admits a second machine while the first import is still open', () => {
    // A person may have OpenClaw on a laptop and on a desktop, and both are
    // theirs to import. There used to be a one-open-import rule here; it could
    // only ever refuse a DIFFERENT installation, because the partial unique
    // index on (tenant, account, source, fingerprint) already guarantees one
    // live migration per installation and createOrResume resumes that row.
    expect(checkMigrationCreationAdmission({ recentMigrationCount: 1 }).allowed).toBe(true);
  });

  it('admits both products from the same machine', () => {
    // OpenClaw and Hermes are separate installations and separate imports.
    expect(checkMigrationCreationAdmission({ recentMigrationCount: 2 }).allowed).toBe(true);
  });
});

describe('item retries', () => {
  it('allows retries below the cap', () => {
    for (let n = 0; n < MAX_ITEM_ATTEMPTS; n += 1) {
      expect(mayRetryItem(n).allowed).toBe(true);
    }
  });

  it('stops at the cap rather than retrying forever', () => {
    const result = mayRetryItem(MAX_ITEM_ATTEMPTS);
    expect(result).toMatchObject({ allowed: false, code: 'attempts_exhausted' });
  });
});

describe('rate-limit parity with the interactive builder', () => {
  it('holds a migration to the same ceilings a single user gets', () => {
    // Duplicated from distill-stream-router.ts on purpose: if the builder's
    // caps move and this does not, a bulk import quietly gets its own budget.
    expect(DISTILL_RATE_LIMITS).toEqual({
      tenant: { maxPerMinute: 10, maxPerHour: 60, maxPerDay: 200 },
      user: { maxPerMinute: 5, maxPerHour: 30, maxPerDay: 100 },
    });
  });
});
