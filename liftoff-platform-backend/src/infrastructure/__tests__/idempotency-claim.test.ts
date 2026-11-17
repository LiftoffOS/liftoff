// claimIdempotencyKey / settleIdempotencyKey — two short statements on
// idempotency_keys, each in its own tenant scope, so no transaction is held
// across the operation they bracket.

const mockQuery = jest.fn();
const mockWithTenantScope = jest.fn(async (_t: string, fn: (c: { query: typeof mockQuery }) => Promise<unknown>) => fn({ query: mockQuery }));
jest.mock('../database', () => ({
  getPool: jest.fn(),
  withTenantScope: (t: string, fn: never) => mockWithTenantScope(t, fn),
}));

import { claimIdempotencyKey, settleIdempotencyKey } from '../idempotency';

const TENANT = '22222222-2222-2222-2222-222222222222';

beforeEach(() => {
  jest.clearAllMocks();
});

describe('claimIdempotencyKey', () => {
  it('inserts the row with no response and answers claimed', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'row-1' }] });
    expect(await claimIdempotencyKey(TENANT, 'k', 'workspace-action:x', 'h')).toBe('claimed');
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('INSERT INTO idempotency_keys');
    expect(String(sql)).toContain('ON CONFLICT (tenant_id, key, endpoint) DO NOTHING');
    expect(String(sql)).toContain('RETURNING id');
    expect(params).toEqual([TENANT, 'k', 'workspace-action:x', 'h']);
    expect(mockWithTenantScope).toHaveBeenCalledTimes(1);
    expect(mockWithTenantScope.mock.calls[0][0]).toBe(TENANT);
  });

  it('a settled row with the same hash replays; a different hash conflicts; an unsettled row is unresolved', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ request_hash: 'h', response_status: 200, response_body: { ok: true } }] });
    expect(await claimIdempotencyKey(TENANT, 'k', 'e', 'h')).toEqual({ replay: { status: 200, body: { ok: true } } });

    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ request_hash: 'other', response_status: 200, response_body: {} }] });
    expect(await claimIdempotencyKey(TENANT, 'k', 'e', 'h')).toBe('conflict');

    mockQuery
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [{ request_hash: 'h', response_status: null, response_body: null }] });
    expect(await claimIdempotencyKey(TENANT, 'k', 'e', 'h')).toBe('unresolved');
  });
});

describe('settleIdempotencyKey', () => {
  it('records the result only on a row that has none', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });
    await settleIdempotencyKey(TENANT, 'k', 'e', 200, { done: true });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(String(sql)).toContain('UPDATE idempotency_keys SET response_status = $4, response_body = $5');
    expect(String(sql)).toContain('AND response_status IS NULL');
    expect(params).toEqual([TENANT, 'k', 'e', 200, JSON.stringify({ done: true })]);
  });
});
