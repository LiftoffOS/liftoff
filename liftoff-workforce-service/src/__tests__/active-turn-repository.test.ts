// The durable stop signal for a CAIO turn.
//
// The failure modes worth pinning are all about a signal arriving on a different
// instance than the turn: a claim stranded by a crash must not block the next
// turn or leak a stale stop into it, a slow turn must not release its
// successor's claim, and a failed read must read as "nobody asked" rather than
// aborting somebody's reply.

const mockQuery = jest.fn();
jest.mock('../infrastructure/rls.js', () => ({
  withTenantContext: (_tenantId: string, fn: (c: { query: jest.Mock }) => unknown) =>
    fn({ query: mockQuery }),
}));
jest.mock('../infrastructure/logging.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  claimTurn,
  isStopRequested,
  releaseTurn,
  requestStop,
} from '../workforce-plans/active-turn-repository.js';

const TENANT = '22222222-2222-2222-2222-222222222222';
const THREAD = '33333333-3333-3333-3333-333333333333';
const TURN = '44444444-4444-4444-4444-444444444444';
const ACCOUNT = '55555555-5555-5555-5555-555555555555';

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
});

describe('claimTurn', () => {
  it('upserts and clears any previous stop, so a stranded row cannot block or leak', async () => {
    await claimTurn(TENANT, THREAD, TURN, ACCOUNT);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (thread_id) DO UPDATE');
    expect(sql).toContain('stop_requested_at = NULL');
    expect(params).toEqual([THREAD, TENANT, TURN, ACCOUNT]);
  });

  it('never throws into the turn', async () => {
    mockQuery.mockRejectedValue(new Error('pool is on fire'));
    await expect(claimTurn(TENANT, THREAD, TURN, ACCOUNT)).resolves.toBeUndefined();
  });
});

describe('releaseTurn', () => {
  it('deletes only its own claim, so a late turn cannot free its successor', async () => {
    await releaseTurn(TENANT, THREAD, TURN);
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('thread_id = $1 AND turn_id = $2');
    expect(params).toEqual([THREAD, TURN]);
  });

  it('never throws into the turn', async () => {
    mockQuery.mockRejectedValue(new Error('pool is on fire'));
    await expect(releaseTurn(TENANT, THREAD, TURN)).resolves.toBeUndefined();
  });
});

describe('requestStop', () => {
  it('reports delivered when a live claim was marked', async () => {
    mockQuery.mockResolvedValue({ rows: [{ turn_id: TURN }], rowCount: 1 });
    expect(await requestStop(TENANT, THREAD, ACCOUNT)).toBe(true);
  });

  it('reports not-delivered when nothing was running', async () => {
    mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
    expect(await requestStop(TENANT, THREAD, ACCOUNT)).toBe(false);
  });

  it('ignores a claim old enough to be stranded', async () => {
    await requestStop(TENANT, THREAD, ACCOUNT);
    const [sql] = mockQuery.mock.calls[0];
    // Without the age bound, a row left behind by a killed instance would keep
    // answering "stopped" for a thread where nothing is running.
    expect(sql).toContain('started_at > NOW() - INTERVAL');
    expect(sql).toContain('stop_requested_at IS NULL');
  });
});

describe('isStopRequested', () => {
  it('is true once the row carries a stop timestamp', async () => {
    mockQuery.mockResolvedValue({ rows: [{ stop_requested_at: new Date() }] });
    expect(await isStopRequested(TENANT, THREAD, TURN)).toBe(true);
  });

  it('is false while the claim is unstopped', async () => {
    mockQuery.mockResolvedValue({ rows: [{ stop_requested_at: null }] });
    expect(await isStopRequested(TENANT, THREAD, TURN)).toBe(false);
  });

  it('is false when the claim is gone', async () => {
    mockQuery.mockResolvedValue({ rows: [] });
    expect(await isStopRequested(TENANT, THREAD, TURN)).toBe(false);
  });

  it('is false when the check itself fails — a broken read must not abort a turn', async () => {
    mockQuery.mockRejectedValue(new Error('pool is on fire'));
    expect(await isStopRequested(TENANT, THREAD, TURN)).toBe(false);
  });
});
