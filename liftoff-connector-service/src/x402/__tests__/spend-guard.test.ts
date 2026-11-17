// x402SpendGuard: the per-call cap formula, the refusal paths (per-call cap,
// vendor and global daily ceilings), and ledger recording. The DB pool is
// mocked — no database.

const queryMock = jest.fn();
jest.mock('../../db/pool.js', () => ({
  getAdminPool: async () => ({ query: queryMock }),
}));

import {
  assertX402SpendAllowed,
  perCallCapUsd,
  recordX402Spend,
  X402SpendRefusedError,
  X402_PER_CALL_FLOOR_USD,
} from '../spend-guard.js';

function ledgerAnswer(vendorSpent: number, totalSpent: number): void {
  queryMock.mockResolvedValueOnce({
    rows: [{ vendor_spent: String(vendorSpent), total_spent: String(totalSpent) }],
  });
}

beforeEach(() => {
  queryMock.mockReset();
  delete process.env.X402_DAILY_CEILING_USD;
  delete process.env.X402_VENDOR_DAILY_CEILING_USD;
});

describe('perCallCapUsd', () => {
  it('is the declared price ×2 with the floor', () => {
    expect(perCallCapUsd(0.05)).toBeCloseTo(0.1, 9);
    expect(perCallCapUsd(0.005)).toBeCloseTo(X402_PER_CALL_FLOOR_USD, 9);
    expect(perCallCapUsd(undefined)).toBeCloseTo(X402_PER_CALL_FLOOR_USD, 9);
  });

  it('lets an explicit override win', () => {
    expect(perCallCapUsd(0.05, 0.03)).toBeCloseTo(0.03, 9);
  });
});

describe('assertX402SpendAllowed', () => {
  it('refuses over the per-call cap without touching the ledger', async () => {
    await expect(assertX402SpendAllowed('gloria', 0.05, 0.02)).rejects.toThrow(X402SpendRefusedError);
    await expect(assertX402SpendAllowed('gloria', 0.05, 0.02)).rejects.toMatchObject({ reason: 'per_call_cap' });
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('allows a payment inside cap and ceilings', async () => {
    ledgerAnswer(0.5, 2);
    await expect(assertX402SpendAllowed('gloria', 0.01, 0.02)).resolves.toBeUndefined();
  });

  it('refuses when the vendor daily ceiling would be crossed', async () => {
    process.env.X402_VENDOR_DAILY_CEILING_USD = '1';
    ledgerAnswer(0.995, 0.995);
    await expect(assertX402SpendAllowed('gloria', 0.01, 0.02)).rejects.toMatchObject({ reason: 'daily_ceiling' });
  });

  it('refuses when the global daily ceiling would be crossed', async () => {
    process.env.X402_DAILY_CEILING_USD = '5';
    ledgerAnswer(0.1, 4.995);
    await expect(assertX402SpendAllowed('gloria', 0.01, 0.02)).rejects.toMatchObject({ reason: 'daily_ceiling' });
  });

  it('fails closed when the ledger cannot be read', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'));
    await expect(assertX402SpendAllowed('gloria', 0.01, 0.02)).rejects.toThrow('db down');
  });
});

describe('recordX402Spend', () => {
  it('upserts the day/vendor row', async () => {
    queryMock.mockResolvedValueOnce({ rowCount: 1 });
    await recordX402Spend('gloria', 0.011);
    expect(queryMock).toHaveBeenCalledTimes(1);
    const [sql, params] = queryMock.mock.calls[0] as [string, unknown[]];
    expect(sql).toContain('INSERT INTO x402_spend_ledger');
    expect(params[1]).toBe('gloria');
    expect(params[2]).toBe(0.011);
  });

  it('ignores a non-positive amount', async () => {
    await recordX402Spend('gloria', 0);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('fails open on a ledger write error — the payment already settled', async () => {
    queryMock.mockRejectedValueOnce(new Error('db down'));
    await expect(recordX402Spend('gloria', 0.01)).resolves.toBeUndefined();
  });
});
