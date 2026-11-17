// The claim is the check.
//
// Two identical capability writes in one run share an idempotency key by
// construction. Whoever's INSERT lands owns the act; the other reads the row
// it lost to and is told what to do. There is no window between a lookup and
// an insert for both to pass through, which is the defect a check-then-act
// guard has.

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  pool: { query: (...a: unknown[]) => mockQuery(...a) },
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { ActionRepository } from '../repository';
import { ActionLedgerService } from '../service';

const WINDOW = 10 * 60_000;
const row = (over: Record<string, unknown> = {}) => ({
  id: 'action-1',
  status: 'pending',
  external_response: null,
  created_at: '2026-09-15T02:34:00.000Z',
  claimed_at: new Date().toISOString(),
  ...over,
});
const input = {
  tenantId: 't1', agentId: 'a1', idempotencyKey: 'cap:inv:op:args', connector: 'capability',
  entityType: '', actionType: 'run_capability', targetRef: 'capability:to/a@x.com@0123456789ab',
  payload: { to: 'a@x.com' }, invocationId: '6ebe2b95-0000-4000-8000-000000000001', actKey: 'cap:op|to/a@x.com@0123456789ab',
  isExternalWrite: true,
};

beforeEach(() => {
  jest.clearAllMocks();
});

describe('ActionRepository.claimAction', () => {
  it('the first claim wins: one INSERT, ON CONFLICT DO NOTHING, and the row is owned', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'action-1' }], rowCount: 1 });
    const repo = new ActionRepository();
    await expect(repo.claimAction(input, WINDOW)).resolves.toEqual({ kind: 'owned', actionId: 'action-1' });
    const [sql, params] = mockQuery.mock.calls[0];
    expect(sql).toContain('ON CONFLICT (idempotency_key) DO NOTHING');
    expect(sql).toContain('claimed_at');
    expect(params).toEqual(expect.arrayContaining(['cap:inv:op:args', 'capability', 'run_capability', true]));
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });

  it('a completed key is replayed, with what the first call returned, and nothing is written', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [row({ status: 'completed', external_response: 'sent 1a0a' })], rowCount: 1 });
    const repo = new ActionRepository();
    await expect(repo.claimAction(input, WINDOW)).resolves.toEqual({
      kind: 'replay', actionId: 'action-1', externalResponse: 'sent 1a0a', createdAt: '2026-09-15T02:34:00.000Z',
    });
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('a fresh pending key belongs to someone else: stand down, do not take it over', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [row()], rowCount: 1 });
    const repo = new ActionRepository();
    await expect(repo.claimAction(input, WINDOW)).resolves.toMatchObject({ kind: 'in_flight', actionId: 'action-1' });
    expect(mockQuery).toHaveBeenCalledTimes(2);
  });

  it('a failed key is taken over, conditionally on the state just read', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [row({ status: 'failed' })], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'action-1' }], rowCount: 1 });
    const repo = new ActionRepository();
    await expect(repo.claimAction(input, WINDOW)).resolves.toEqual({ kind: 'owned', actionId: 'action-1' });
    const [sql] = mockQuery.mock.calls[2];
    expect(sql).toContain("SET status = 'pending'");
    expect(sql).toContain("status = 'failed'");
    expect(sql).toContain('claimed_at = NOW()');
  });

  it('a pending key past the in-flight window is taken over — its owner went quiet', async () => {
    const stale = new Date(Date.now() - WINDOW - 60_000).toISOString();
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [row({ claimed_at: stale })], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [{ id: 'action-1' }], rowCount: 1 });
    const repo = new ActionRepository();
    await expect(repo.claimAction(input, WINDOW)).resolves.toEqual({ kind: 'owned', actionId: 'action-1' });
  });

  it('two takers racing for a stale key: the one whose UPDATE matched nothing re-reads and stands down', async () => {
    const stale = new Date(Date.now() - WINDOW - 60_000).toISOString();
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [row({ claimed_at: stale })], rowCount: 1 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })                 // UPDATE lost
      .mockResolvedValueOnce({ rows: [row()], rowCount: 1 });           // re-read: fresh pending, the winner's
    const repo = new ActionRepository();
    await expect(repo.claimAction(input, WINDOW)).resolves.toMatchObject({ kind: 'in_flight' });
    expect(mockQuery).toHaveBeenCalledTimes(4);
  });

  it('a conflict with no row to read back is an error, not a silent dispatch', async () => {
    mockQuery
      .mockResolvedValueOnce({ rows: [], rowCount: 0 })
      .mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const repo = new ActionRepository();
    await expect(repo.claimAction(input, WINDOW)).rejects.toThrow(/no row could be read back/);
  });
});

describe('ActionLedgerService.claimCapabilityWrite', () => {
  it('requires the write-marked handle — a read handle gets a throw, not a row', async () => {
    const svc = new ActionLedgerService();
    await expect(svc.claimCapabilityWrite(input as never, 'cap_r.0123456789ab.x')).rejects.toThrow(/write-marked/);
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('claims with is_external_write true, which the name-based classifier would not give run_capability', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ id: 'action-1' }], rowCount: 1 });
    const svc = new ActionLedgerService();
    await svc.claimCapabilityWrite(input as never, 'cap_w.0123456789ab.x');
    const params = mockQuery.mock.calls[0][1] as unknown[];
    // is_external_write is the 18th value in the claim insert.
    expect(params[17]).toBe(true);
  });
});
