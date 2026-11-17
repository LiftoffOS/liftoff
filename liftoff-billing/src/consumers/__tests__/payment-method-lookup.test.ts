// lookupDefaultPaymentMethod — reads the local payment_methods table for
// the default PM on a tenant. Used by stripe-event-processor (receipt +
// auto-reload-failed payloads) and internal-admin-router (auto-reload
// failure handler).

import { describe, it, expect, jest } from '@jest/globals';
import type { Pool } from 'pg';

import { lookupDefaultPaymentMethod } from '../payment-method-lookup.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockFn = (): any => (jest.fn as any)();
/* eslint-enable @typescript-eslint/no-explicit-any */

function mockPool(rows: Array<{ brand: string; last4: string }>): Pool {
  return {
    query: mockFn().mockResolvedValue({ rows, rowCount: rows.length }),
  } as unknown as Pool;
}

describe('lookupDefaultPaymentMethod', () => {
  it('returns { type: card, last4 } when default PM exists', async () => {
    const pool = mockPool([{ brand: 'visa', last4: '4242' }]);
    const out = await lookupDefaultPaymentMethod(pool, 'tenant-1');
    expect(out).toEqual({ type: 'card', last4: '4242' });
  });

  it('returns null when no default PM exists', async () => {
    const pool = mockPool([]);
    const out = await lookupDefaultPaymentMethod(pool, 'tenant-1');
    expect(out).toBeNull();
  });

  it('always returns type=card (local table does not store us_bank_account)', async () => {
    const pool = mockPool([{ brand: 'mastercard', last4: '0001' }]);
    const out = await lookupDefaultPaymentMethod(pool, 'tenant-1');
    expect(out?.type).toBe('card');
    expect(out?.last4).toBe('0001');
  });
});
