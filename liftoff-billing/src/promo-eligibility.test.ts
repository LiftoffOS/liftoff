// promo-eligibility — unit tests covering both signals (fingerprint deleted,
// email-deletion-ledger match), the eligible-true happy path, and the
// false-positive guard for cross-tenant card sharing between active customers.

import { describe, it, expect, jest } from '@jest/globals';
import type Stripe from 'stripe';
import type { Pool } from 'pg';
import type { PlatformBackendClient } from './infrastructure/platform-backend-client.js';
import { checkPromoEligibility } from './promo-eligibility';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockFn = (): any => (jest.fn as any)();
/* eslint-enable @typescript-eslint/no-explicit-any */

function makePool(fingerprintHasDeletedHit: boolean): Pool {
  return {
    query: mockFn().mockResolvedValue({
      rows: fingerprintHasDeletedHit ? [{}] : [],
      rowCount: fingerprintHasDeletedHit ? 1 : 0,
    }),
  } as unknown as Pool;
}

function makeStripe(opts: { fingerprint?: string; emailHash?: string | null }): Stripe {
  return {
    paymentMethods: {
      retrieve: mockFn().mockResolvedValue({
        id: 'pm_test',
        card: opts.fingerprint ? { fingerprint: opts.fingerprint } : {},
      }),
    },
    customers: {
      retrieve: mockFn().mockResolvedValue({
        id: 'cus_current',
        metadata: opts.emailHash ? { email_sha256: opts.emailHash } : {},
      }),
    },
  } as unknown as Stripe;
}

function makePbClient(matched: boolean): PlatformBackendClient {
  return {
    checkDeletionHistory: mockFn().mockResolvedValue({ matched }),
  } as unknown as PlatformBackendClient;
}

const ARGS = { stripeCustomerId: 'cus_current', paymentMethodId: 'pm_test' };

describe('checkPromoEligibility', () => {
  it('eligible: true when fingerprint never seen and customer has no email_sha256 metadata', async () => {
    const deps = {
      stripe: makeStripe({ fingerprint: 'fp_clean', emailHash: null }),
      pool: makePool(false),
      pbClient: makePbClient(false),
    };
    const r = await checkPromoEligibility(deps, ARGS);
    expect(r).toEqual({ eligible: true });
  });

  it("eligible: false with signal 'fingerprint_deleted' when fingerprint exists on a different, deleted customer", async () => {
    const deps = {
      stripe: makeStripe({ fingerprint: 'fp_reused', emailHash: null }),
      pool: makePool(true),
      pbClient: makePbClient(false),
    };
    const r = await checkPromoEligibility(deps, ARGS);
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.signals).toContain('fingerprint_deleted');
  });

  it("eligible: false with signal 'email_deletion' when customer's email_sha256 matches a deletion ledger row", async () => {
    const deps = {
      stripe: makeStripe({ fingerprint: 'fp_clean', emailHash: 'hash_known_deleted' }),
      pool: makePool(false),
      pbClient: makePbClient(true),
    };
    const r = await checkPromoEligibility(deps, ARGS);
    expect(r.eligible).toBe(false);
    if (!r.eligible) expect(r.signals).toContain('email_deletion');
  });

  it('eligible: false with both signals when both match', async () => {
    const deps = {
      stripe: makeStripe({ fingerprint: 'fp_reused', emailHash: 'hash_known_deleted' }),
      pool: makePool(true),
      pbClient: makePbClient(true),
    };
    const r = await checkPromoEligibility(deps, ARGS);
    expect(r.eligible).toBe(false);
    if (!r.eligible) {
      expect(r.signals).toContain('fingerprint_deleted');
      expect(r.signals).toContain('email_deletion');
    }
  });

  it('cross-tenant card sharing between two active customers is eligible: true (no false positive)', async () => {
    // pool returns no rows because the query filters customer_status='deleted'.
    const deps = {
      stripe: makeStripe({ fingerprint: 'fp_shared', emailHash: null }),
      pool: makePool(false),
      pbClient: makePbClient(false),
    };
    const r = await checkPromoEligibility(deps, ARGS);
    expect(r).toEqual({ eligible: true });
  });
});
