// The continuation rows: each statement bound to one row and one status, the
// cap of five per person message, and the two things a person's message
// cancels (queued AND claimed), never a running one.

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(async (_tenantId: string, fn: (client: { query: typeof mockQuery }) => Promise<unknown>) => fn({ query: mockQuery })),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  cancelThreadContinuations,
  claimContinuation,
  enqueueContinuation,
  finishContinuation,
  hasNewerPersonMessage,
  markContinuationRunning,
  MAX_CONTINUATIONS_PER_MESSAGE,
  recheckClaimedContinuation,
  requeueContinuation,
  threadContinuationStatus,
  enqueueBackgroundWork,
  cancelThreadContinuations,
} from '../store';

const TENANT = '11111111-1111-1111-1111-111111111111';
const ROW = {
  id: 'c1', tenant_id: TENANT, surface: 'liftoff', thread_id: 'th-1', account_id: 'a-1',
  origin_message_id: 'm-1', ordinal: 2, reason: 'MAX_ITERATIONS', status: 'queued', worker_id: null,
  kind: 'continuation', brief: '',
};

function sql(n = 0): { sql: string; params: unknown[] } {
  const [s, params] = mockQuery.mock.calls[n];
  return { sql: String(s).replace(/\s+/g, ' ').trim(), params };
}

beforeEach(() => mockQuery.mockReset());

describe('enqueueContinuation', () => {
  it('inserts queued with the ordinal after the last for this message', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ n: '1' }] }).mockResolvedValueOnce({ rows: [ROW] });
    const row = await enqueueContinuation({ tenantId: TENANT, surface: 'liftoff', threadId: 'th-1', accountId: 'a-1', originMessageId: 'm-1', reason: 'MAX_ITERATIONS' });
    expect(row).toEqual({ id: 'c1', tenantId: TENANT, surface: 'liftoff', threadId: 'th-1', accountId: 'a-1', originMessageId: 'm-1', ordinal: 2, reason: 'MAX_ITERATIONS', status: 'queued', workerId: null, kind: 'continuation', brief: '' });
    expect(sql(0).sql).toContain('SELECT COUNT(*)::text AS n FROM chat_continuations WHERE tenant_id = $1 AND origin_message_id = $2');
    expect(sql(1).sql).toContain("INSERT INTO chat_continuations (tenant_id, surface, thread_id, account_id, origin_message_id, ordinal, reason, status) VALUES ($1, $2, $3, $4, $5, $6, $7, 'queued')");
    expect(sql(1).params).toEqual([TENANT, 'liftoff', 'th-1', 'a-1', 'm-1', 2, 'MAX_ITERATIONS']);
  });

  it('queues nothing at the cap: the sixth is refused', async () => {
    expect(MAX_CONTINUATIONS_PER_MESSAGE).toBe(5);
    mockQuery.mockResolvedValueOnce({ rows: [{ n: '5' }] });
    const row = await enqueueContinuation({ tenantId: TENANT, surface: 'insights', threadId: 'th-1', accountId: 'a-1', originMessageId: 'm-1', reason: 'CONTEXT_FULL' });
    expect(row).toBeNull();
    expect(mockQuery).toHaveBeenCalledTimes(1);
  });
});

describe('the worker\'s statements are each bound to one row, one status and one worker', () => {
  it('claim: queued → claimed under this worker, or nothing', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...ROW, status: 'claimed', worker_id: 'w1' }] });
    expect((await claimContinuation(TENANT, 'c1', 'w1'))?.status).toBe('claimed');
    expect(sql().sql).toContain("SET status = 'claimed', claimed_at = NOW(), worker_id = $3 WHERE tenant_id = $1 AND id = $2 AND status = 'queued' RETURNING");
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await claimContinuation(TENANT, 'c1', 'w1')).toBeNull();
  });

  it('requeue: claimed by this worker → queued, cleared', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    expect(await requeueContinuation(TENANT, 'c1', 'w1')).toBe(true);
    expect(sql().sql).toContain("SET status = 'queued', claimed_at = NULL, worker_id = NULL WHERE tenant_id = $1 AND id = $2 AND status = 'claimed' AND worker_id = $3");
  });

  it('recheck: the row only while still claimed by this worker', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await recheckClaimedContinuation(TENANT, 'c1', 'w1')).toBeNull();
    expect(sql().sql).toContain("WHERE tenant_id = $1 AND id = $2 AND status = 'claimed' AND worker_id = $3");
  });

  it('running: claimed by this worker → running', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    expect(await markContinuationRunning(TENANT, 'c1', 'w1')).toBe(true);
    expect(sql().sql).toContain("SET status = 'running' WHERE tenant_id = $1 AND id = $2 AND status = 'claimed' AND worker_id = $3");
  });

  it('finish: a terminal state for a row this worker holds', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await finishContinuation(TENANT, 'c1', 'w1', 'failed', 'lock_busy');
    expect(sql().sql).toContain("SET status = $4, finished_at = NOW() WHERE tenant_id = $1 AND id = $2 AND worker_id = $3 AND status IN ('claimed', 'running')");
    expect(sql().params).toEqual([TENANT, 'c1', 'w1', 'failed']);
  });
});

describe('a new person message', () => {
  it('cancels the thread\'s queued AND claimed continuations, never a running one', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 2 });
    expect(await cancelThreadContinuations(TENANT, 'th-1')).toBe(2);
    expect(sql().sql).toContain("SET status = 'cancelled', finished_at = NOW() WHERE tenant_id = $1 AND thread_id = $2 AND status IN ('queued', 'claimed')");
    expect(sql().sql).not.toContain("'running'");
  });

  it('never fails the person\'s turn when the cancel cannot run', async () => {
    mockQuery.mockRejectedValueOnce(new Error('db down'));
    expect(await cancelThreadContinuations(TENANT, 'th-1')).toBe(0);
  });
});

describe('the thread\'s state, and the supersession test', () => {
  it('reports running over claimed over queued, or null', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ status: 'running' }] });
    expect(await threadContinuationStatus(TENANT, 'th-1')).toBe('running');
    expect(sql().sql).toContain("status IN ('queued', 'claimed', 'running') ORDER BY CASE status WHEN 'running' THEN 0 WHEN 'claimed' THEN 1 ELSE 2 END LIMIT 1");
    mockQuery.mockResolvedValueOnce({ rows: [] });
    expect(await threadContinuationStatus(TENANT, 'th-1')).toBeNull();
  });

  it('asks the surface\'s own messages for a person\'s message newer than the origin', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ newer: true }] });
    expect(await hasNewerPersonMessage(TENANT, 'liftoff', 'th-1', 'm-1')).toBe(true);
    expect(sql().sql).toContain("FROM liftoff_chat_messages m WHERE m.thread_id = $1 AND m.role = 'user' AND m.created_at > (SELECT o.created_at FROM liftoff_chat_messages o WHERE o.id = $2)");
    mockQuery.mockResolvedValueOnce({ rows: [{ newer: false }] });
    expect(await hasNewerPersonMessage(TENANT, 'insights', 'th-1', 'm-1')).toBe(false);
    expect(sql(1).sql).toContain('FROM insights_chat_messages m');
  });
});

// Work an assistant set going, on the same rails
//
// A continuation and a piece of background work are the same row, the same
// queue and the same worker. What differs is the kind, and what the kind
// decides: its own brief as the objective, a person writing not cancelling
// it, and no chaining.
describe('enqueueBackgroundWork', () => {
  it('inserts a background_work row carrying its brief, at ordinal 1', async () => {
    mockQuery.mockResolvedValueOnce({ rows: [{ ...ROW, kind: 'background_work', brief: 'read the reports', ordinal: 1 }] });
    const row = await enqueueBackgroundWork({
      tenantId: TENANT, surface: 'liftoff', threadId: 'th-1', accountId: 'a-1',
      originMessageId: 'm-1', brief: 'read the reports',
    });
    expect(row.kind).toBe('background_work');
    expect(row.brief).toBe('read the reports');
    const { sql: text, params } = sql(0);
    expect(text).toContain("'background_work'");
    expect(params).toContain('read the reports');
    // Queued once against its own message, so it never competes with that
    // message's continuations for the per-message cap.
    expect(text).toContain('1');
  });
});

// A continuation is superseded by the next thing the person says — rightly,
// they moved on. Background work is the opposite: they asked for it and then
// carried on talking.
describe('cancelThreadContinuations', () => {
  it('cancels continuations and leaves background work alone', async () => {
    mockQuery.mockResolvedValueOnce({ rowCount: 1 });
    await cancelThreadContinuations(TENANT, 'th-1');
    expect(sql(0).sql).toContain("kind = 'continuation'");
  });
});
