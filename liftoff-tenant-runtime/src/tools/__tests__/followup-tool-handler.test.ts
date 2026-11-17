// L2 — schedule_followup / cancel_followup unit tests.
//
// These are validation-only tests; DB + Cloud Tasks deps are mocked.

const mockConnect = jest.fn();
const mockQuery = jest.fn();
const mockRelease = jest.fn();
const mockTopLevelQuery = jest.fn();

const mockEnqueue = jest.fn();
const mockCancel = jest.fn();
const mockRepoUpdate = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({
    query: mockTopLevelQuery,
    connect: () => Promise.resolve({
      query: mockQuery,
      release: mockRelease,
    }),
  }),
}));

jest.mock('../../infrastructure/cloud-tasks', () => ({
  enqueueAgentExecution: mockEnqueue,
  cancelScheduledAgentExecution: mockCancel,
}));

jest.mock('../../scheduling/agent-scheduled-invocations-repo', () => ({
  agentScheduledInvocationsRepo: {
    updateCloudTaskName: mockRepoUpdate,
  },
}));

import { handleScheduleFollowup, handleCancelFollowup } from '../followup-tool-handler';
import type { StandardToolContext } from '../standard-tool-handler';

const ctx: StandardToolContext = {
  tenantId: 't1',
  agentId: 'a1',
  memoryScope: {},
  threadId: 'thread-1',
  invocationId: 'inv-1',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockTopLevelQuery.mockResolvedValue({
    rows: [{ agent_count: '0', tenant_count: '0' }],
    rowCount: 1,
  });
  mockQuery.mockImplementation((sql: string) => {
    if (/BEGIN|COMMIT|ROLLBACK/i.test(sql)) return Promise.resolve({ rows: [], rowCount: 0 });
    if (/FOR UPDATE/i.test(sql)) return Promise.resolve({ rows: [], rowCount: 0 });
    if (/INSERT INTO agent_scheduled_invocations/i.test(sql)) {
      return Promise.resolve({ rows: [{ id: 'row-1' }], rowCount: 1 });
    }
    return Promise.resolve({ rows: [], rowCount: 0 });
  });
  mockEnqueue.mockResolvedValue({ taskName: 'projects/.../tasks/x', scheduleKey: '', contextRef: null });
});

describe('schedule_followup', () => {
  it('rejects when context_ref is missing', async () => {
    const r = await handleScheduleFollowup({ objective: 'X', delay_seconds: 3600 }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/context_ref/);
  });

  it('rejects when objective is missing', async () => {
    const r = await handleScheduleFollowup({ context_ref: 'thread-1', delay_seconds: 3600 }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/objective/);
  });

  it('rejects when both delay_seconds and at are provided', async () => {
    const r = await handleScheduleFollowup({
      context_ref: 'thread-1',
      objective: 'follow up',
      delay_seconds: 3600,
      at: new Date(Date.now() + 3600_000).toISOString(),
    }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/exactly one/);
  });

  it('rejects when neither delay_seconds nor at is provided', async () => {
    const r = await handleScheduleFollowup({ context_ref: 'thread-1', objective: 'follow up' }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/exactly one/);
  });

  it('rejects delays under 60s', async () => {
    const r = await handleScheduleFollowup({
      context_ref: 'thread-1', objective: 'follow up', delay_seconds: 30,
    }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/at least 60s/);
  });

  it('rejects delays over 30 days', async () => {
    const r = await handleScheduleFollowup({
      context_ref: 'thread-1', objective: 'follow up', delay_seconds: 31 * 24 * 60 * 60,
    }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/within 30d/);
  });

  it('rejects when `at` is unparseable', async () => {
    const r = await handleScheduleFollowup({
      context_ref: 'thread-1', objective: 'X', at: 'not-a-date',
    }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/ISO-8601/);
  });

  it('enqueues a task and returns fires_at on the happy path', async () => {
    const r = await handleScheduleFollowup({
      context_ref: 'thread-1',
      objective: 'reply if no response',
      delay_seconds: 48 * 60 * 60,
    }, ctx);
    expect(r.success).toBe(true);
    expect(mockEnqueue).toHaveBeenCalledTimes(1);
    expect(mockEnqueue).toHaveBeenCalledWith('t1', 'a1', expect.objectContaining({
      triggeredBy: 'agent',
      triggeredByLabel: 'self_scheduled:thread-1',
      contextRef: 'thread-1',
      scheduleTime: expect.any(Date),
    }));
    expect(mockRepoUpdate).toHaveBeenCalledWith('row-1', 'projects/.../tasks/x');
    expect((r.result as { context_ref: string }).context_ref).toBe('thread-1');
  });

  // Chain-depth bound for self-scheduled loops.
  it('defaults to depth 0 and schedules the follow-up at depth 1 (non-self-scheduled trigger)', async () => {
    const r = await handleScheduleFollowup({
      context_ref: 'loop', objective: 'check again', delay_seconds: 3600,
    }, ctx); // ctx has no chainDepth -> currentDepth 0
    expect(r.success).toBe(true);
    const insert = mockQuery.mock.calls.find(c => /INSERT INTO agent_scheduled_invocations/i.test(c[0]));
    expect(insert).toBeDefined();
    expect(insert![1][insert![1].length - 1]).toBe(1); // chain_depth = nextDepth = 1
    expect(mockEnqueue).toHaveBeenCalledWith('t1', 'a1', expect.objectContaining({ chainDepth: 1 }));
  });

  it('increments chain_depth from the triggering execution depth', async () => {
    const r = await handleScheduleFollowup({
      context_ref: 'loop', objective: 'check again', delay_seconds: 3600,
    }, { ...ctx, chainDepth: 3 });
    expect(r.success).toBe(true);
    const insert = mockQuery.mock.calls.find(c => /INSERT INTO agent_scheduled_invocations/i.test(c[0]));
    expect(insert![1][insert![1].length - 1]).toBe(4); // 3 + 1
    expect(mockEnqueue).toHaveBeenCalledWith('t1', 'a1', expect.objectContaining({ chainDepth: 4 }));
  });

  it('rejects once the chain depth cap is reached (loop circuit-breaker)', async () => {
    const r = await handleScheduleFollowup({
      context_ref: 'loop', objective: 'check again', delay_seconds: 3600,
    }, { ...ctx, chainDepth: 10 }); // MAX_CHAIN_DEPTH default
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/max self-schedule chain depth/);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('rejects when per-agent quota is reached', async () => {
    mockTopLevelQuery.mockResolvedValueOnce({
      rows: [{ agent_count: '5000', tenant_count: '5000' }],
      rowCount: 1,
    });
    const r = await handleScheduleFollowup({
      context_ref: 'thread-1', objective: 'X', delay_seconds: 3600,
    }, ctx);
    expect(r.success).toBe(false);
    expect(r.error).toMatch(/per-agent pending quota/);
  });

  it('replace semantics: cancels prior pending row before inserting', async () => {
    mockQuery.mockImplementation((sql: string) => {
      if (/BEGIN|COMMIT|ROLLBACK/i.test(sql)) return Promise.resolve({ rows: [], rowCount: 0 });
      if (/FOR UPDATE/i.test(sql)) {
        return Promise.resolve({
          rows: [{ id: 'old-row', cloud_task_name: 'projects/.../tasks/old', schedule_key: '2026-06-01T12:00' }],
          rowCount: 1,
        });
      }
      if (/UPDATE agent_scheduled_invocations/i.test(sql)) {
        return Promise.resolve({ rows: [], rowCount: 1 });
      }
      if (/INSERT INTO agent_scheduled_invocations/i.test(sql)) {
        return Promise.resolve({ rows: [{ id: 'new-row' }], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    });

    const r = await handleScheduleFollowup({
      context_ref: 'thread-1', objective: 'X', delay_seconds: 3600,
    }, ctx);
    expect(r.success).toBe(true);
    expect(mockCancel).toHaveBeenCalledWith('t1', 'a1', '2026-06-01T12:00', 'thread-1');
  });
});

describe('cancel_followup', () => {
  it('rejects when context_ref is missing', async () => {
    const r = await handleCancelFollowup({}, ctx);
    expect(r.success).toBe(false);
  });

  it('returns cancelled:false when no pending row exists', async () => {
    mockTopLevelQuery.mockResolvedValueOnce({ rows: [], rowCount: 0 });
    const r = await handleCancelFollowup({ context_ref: 'thread-1' }, ctx);
    expect(r.success).toBe(true);
    expect((r.result as { cancelled: boolean }).cancelled).toBe(false);
    expect(mockCancel).not.toHaveBeenCalled();
  });

  it('returns cancelled:true and deletes the Cloud Task when a row exists', async () => {
    mockTopLevelQuery.mockResolvedValueOnce({
      rows: [{ id: 'row-1', cloud_task_name: 'projects/.../tasks/x', schedule_key: '2026-06-01T12:00' }],
      rowCount: 1,
    });
    const r = await handleCancelFollowup({ context_ref: 'thread-1' }, ctx);
    expect(r.success).toBe(true);
    expect((r.result as { cancelled: boolean }).cancelled).toBe(true);
    expect(mockCancel).toHaveBeenCalledWith('t1', 'a1', '2026-06-01T12:00', 'thread-1');
  });

  it('is idempotent: NOT_FOUND on Cloud Task delete is treated as success', async () => {
    mockTopLevelQuery.mockResolvedValueOnce({
      rows: [{ id: 'row-1', cloud_task_name: 'projects/.../tasks/x', schedule_key: '2026-06-01T12:00' }],
      rowCount: 1,
    });
    mockCancel.mockRejectedValueOnce(Object.assign(new Error('NOT_FOUND'), { code: 5 }));
    const r = await handleCancelFollowup({ context_ref: 'thread-1' }, ctx);
    expect(r.success).toBe(true);
  });
});

describe('schedule_followup — taint inheritance', () => {
  it('an untrusted-origin run stamps _originTrust on the scheduled run inputData', async () => {
    const untrustedCtx: StandardToolContext = { ...ctx, trustLevel: 'untrusted_inbound' };
    const r = await handleScheduleFollowup(
      { context_ref: 'thread-1', objective: 'follow up', delay_seconds: 120 },
      untrustedCtx,
    );
    expect(r.success).toBe(true);
    const opts = mockEnqueue.mock.calls[0][2] as { inputData?: Record<string, unknown> };
    expect(opts.inputData).toEqual({ _originTrust: 'untrusted_inbound' });
  });

  it('a trusted run schedules without a taint marker', async () => {
    const r = await handleScheduleFollowup(
      { context_ref: 'thread-1', objective: 'follow up', delay_seconds: 120 },
      ctx,
    );
    expect(r.success).toBe(true);
    const opts = mockEnqueue.mock.calls[0][2] as { inputData?: Record<string, unknown> };
    expect(opts.inputData).toBeUndefined();
  });
});
