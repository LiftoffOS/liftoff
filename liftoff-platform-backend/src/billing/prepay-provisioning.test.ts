// Seeding the billing_controls row for a workspace that has not subscribed.
//
// The property worth protecting is the rate: the three rate columns default to
// 0 (migration 209) and a zero rate bills nothing, so every path that cannot
// read the configured rate has to land on a real one instead.

jest.mock('../infrastructure/database', () => ({
  getPool: jest.fn(),
}));

const mockLog = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../infrastructure/logging', () => ({ log: mockLog }));

import { getPool } from '../infrastructure/database';
import {
  ensurePayAsYouGoControlsRow,
  _resetPayAsYouGoRateCacheForTesting,
} from './prepay-provisioning';

const ACCOUNT_ID = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
const CONFIGURED_RATE = 0.031250;

function mockPool(settingsRows: Array<{ value: string }>): jest.Mock {
  const query = jest.fn();
  query.mockResolvedValueOnce({ rows: settingsRows, rowCount: settingsRows.length }); // rate read
  query.mockResolvedValue({ rows: [], rowCount: 1 });                                 // the INSERT
  (getPool as jest.Mock).mockReturnValue({ query });
  return query;
}

beforeEach(() => {
  jest.clearAllMocks();
  _resetPayAsYouGoRateCacheForTesting();
});

describe('ensurePayAsYouGoControlsRow', () => {
  it('seeds a pre-pay row that is suspended until somebody funds it', async () => {
    const query = mockPool([{ value: String(CONFIGURED_RATE) }]);

    await ensurePayAsYouGoControlsRow(ACCOUNT_ID);

    const insert = String(query.mock.calls[1][0]);
    expect(insert).toMatch(/INSERT INTO billing_controls/);
    expect(insert).toMatch(/'pre_pay', TRUE, 'zero_prepaid_balance'/);
    expect(query.mock.calls[1][1]).toEqual([ACCOUNT_ID, CONFIGURED_RATE]);
  });

  // A second call must not disturb an account that has since subscribed: the
  // activation owns the plan columns and the rates by then.
  it('does nothing to a row that already exists', async () => {
    const query = mockPool([{ value: String(CONFIGURED_RATE) }]);

    await ensurePayAsYouGoControlsRow(ACCOUNT_ID);

    expect(String(query.mock.calls[1][0])).toMatch(/ON CONFLICT \(account_id\) DO NOTHING/);
  });

  // Only the reload rate is reachable while the included and precommit bands
  // are zero-width, but a referral bonus widens the precommit band and
  // subscription activation COALESCEs onto whatever is here.
  it('writes the same rate to all three rate columns', async () => {
    const query = mockPool([{ value: String(CONFIGURED_RATE) }]);

    await ensurePayAsYouGoControlsRow(ACCOUNT_ID);

    const insert = String(query.mock.calls[1][0]);
    expect(insert).toMatch(/included_rate_usd_per_ou, precommit_rate_usd_per_ou, reload_rate_usd_per_ou/);
    expect(insert).toMatch(/\$2, \$2, \$2/);
  });

  it('inherits the account\'s internal exemption rather than guessing it', async () => {
    const query = mockPool([{ value: String(CONFIGURED_RATE) }]);

    await ensurePayAsYouGoControlsRow(ACCOUNT_ID);

    expect(String(query.mock.calls[1][0]))
      .toMatch(/COALESCE\(\(SELECT is_internal FROM accounts WHERE id = \$1\), FALSE\)/);
  });

  // The row has to be addressable, not just present. liftoff-billing knows
  // Stripe customers rather than accounts, and its callbacks resolve
  // /controls/cus_.../prepaid-topped-up through this column; seeded without
  // it, the first top-up on a workspace that never subscribed answered 404
  // and credited nothing.
  it('copies the account\'s Stripe customer so the row can be credited', async () => {
    const query = mockPool([{ value: String(CONFIGURED_RATE) }]);

    await ensurePayAsYouGoControlsRow(ACCOUNT_ID);

    const insert = String(query.mock.calls[1][0]);
    expect(insert).toMatch(/billing_exempt, stripe_customer_id/);
    expect(insert).toMatch(/\(SELECT stripe_customer_id FROM accounts WHERE id = \$1\)/);
  });
});

describe('the rate it seeds', () => {
  it('never falls back to zero when the setting is missing', async () => {
    const query = mockPool([]);

    await ensurePayAsYouGoControlsRow(ACCOUNT_ID);

    const rate = (query.mock.calls[1][1] as unknown[])[1] as number;
    expect(rate).toBeGreaterThan(0);
    expect(mockLog.error).toHaveBeenCalled();
  });

  it('never falls back to zero when the setting is not a positive number', async () => {
    const query = mockPool([{ value: '0' }]);

    await ensurePayAsYouGoControlsRow(ACCOUNT_ID);

    const rate = (query.mock.calls[1][1] as unknown[])[1] as number;
    expect(rate).toBeGreaterThan(0);
    expect(mockLog.error).toHaveBeenCalled();
  });

  it('survives a database error without billing nothing', async () => {
    const query = jest.fn();
    query.mockRejectedValueOnce(new Error('connection reset')); // rate read
    query.mockResolvedValue({ rows: [], rowCount: 1 });         // the INSERT
    (getPool as jest.Mock).mockReturnValue({ query });

    await ensurePayAsYouGoControlsRow(ACCOUNT_ID);

    const rate = (query.mock.calls[1][1] as unknown[])[1] as number;
    expect(rate).toBeGreaterThan(0);
    expect(mockLog.error).toHaveBeenCalled();
  });

  // A transient failure must not poison the cache, or one bad moment would
  // pin every workspace provisioned in the next five minutes to the fallback.
  it('does not cache a fallback taken because of a database error', async () => {
    const query = jest.fn();
    query.mockRejectedValueOnce(new Error('connection reset'));
    query.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    query.mockResolvedValueOnce({ rows: [{ value: '0.05' }], rowCount: 1 });
    query.mockResolvedValue({ rows: [], rowCount: 1 });
    (getPool as jest.Mock).mockReturnValue({ query });

    await ensurePayAsYouGoControlsRow(ACCOUNT_ID);
    await ensurePayAsYouGoControlsRow(ACCOUNT_ID);

    expect((query.mock.calls[3][1] as unknown[])[1]).toBe(0.05);
  });

  it('reads the setting once and reuses it inside the TTL', async () => {
    const query = mockPool([{ value: String(CONFIGURED_RATE) }]);

    await ensurePayAsYouGoControlsRow(ACCOUNT_ID);
    await ensurePayAsYouGoControlsRow(ACCOUNT_ID);

    const reads = query.mock.calls.filter((c) => String(c[0]).includes('billing_system_settings'));
    expect(reads).toHaveLength(1);
  });
});
