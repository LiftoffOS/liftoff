// B.2 — schedule_followup / cancel_followup standard tool handler tests.
//
// Two failure modes the existing followup-tool-handler.test.ts already
// covers (the dedicated test file). This file adds COVERAGE FOR THE
// SCHEMA REJECTION BOUNDARY because the existing tests skew towards
// happy-path + quota — schema fences (XOR validation, min/max delay,
// missing fields) need their own pin so a future refactor of the
// validation block doesn't accidentally weaken it.

const mockSchedule = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
const mockCancel = jest.fn().mockResolvedValue({ rows: [{ task_name: 'projects/p/locations/l/queues/q/tasks/t' }], rowCount: 1 });

jest.mock('../../scheduling/agent-scheduled-invocations-repo', () => ({
  agentScheduledInvocationsRepo: {
    insertPending: mockSchedule,
    countPendingForAgent: jest.fn().mockResolvedValue(0),
    countPendingForTenant: jest.fn().mockResolvedValue(0),
    cancelByContextRef: mockCancel,
    findByContextRef: jest.fn().mockResolvedValue(null),
    updateTaskName: jest.fn().mockResolvedValue(undefined),
  },
}));

jest.mock('../../infrastructure/cloud-tasks', () => ({
  enqueueAgentExecution: jest.fn().mockResolvedValue({ name: 'projects/p/locations/l/queues/q/tasks/abc' }),
  cancelScheduledAgentExecution: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../../infrastructure/database', () => {
  const query = jest.fn().mockResolvedValue({ rows: [], rowCount: 0 });
  const client = {
    query,
    release: jest.fn(),
  };
  return {
    getPool: jest.fn().mockReturnValue({
      query,
      connect: jest.fn().mockResolvedValue(client),
    }),
  };
});

import { executeStandardTool, StandardToolContext } from '../standard-tool-handler';

const ctx: StandardToolContext = {
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  memoryScope: { writableLayers: [], readableLayers: [] },
  traceId: 'trace-1',
  threadId: '00000000-0000-0000-0000-000000000001',
};

beforeEach(() => jest.clearAllMocks());

describe('schedule_followup — XOR validation', () => {
  it('rejects when neither delay_seconds nor at is provided', async () => {
    const r = await executeStandardTool('schedule_followup', {
      context_ref: 'ctx-1',
      objective: 'Check on the thing',
    }, ctx);
    expect(r?.success).toBe(false);
  });

  it('rejects when BOTH delay_seconds AND at are provided', async () => {
    const r = await executeStandardTool('schedule_followup', {
      context_ref: 'ctx-1',
      objective: 'Check on the thing',
      delay_seconds: 300,
      at: '2026-12-31T00:00:00Z',
    }, ctx);
    expect(r?.success).toBe(false);
  });
});

describe('schedule_followup — bounds enforcement', () => {
  it('rejects delay below 60s', async () => {
    const r = await executeStandardTool('schedule_followup', {
      context_ref: 'ctx-1',
      objective: 'Soon',
      delay_seconds: 30,
    }, ctx);
    expect(r?.success).toBe(false);
  });

  it('rejects delay above 30 days', async () => {
    const r = await executeStandardTool('schedule_followup', {
      context_ref: 'ctx-1',
      objective: 'Way out',
      delay_seconds: 31 * 24 * 60 * 60,
    }, ctx);
    expect(r?.success).toBe(false);
  });
});

describe('schedule_followup — required fields', () => {
  it('rejects missing context_ref', async () => {
    const r = await executeStandardTool('schedule_followup', {
      objective: 'Need context_ref',
      delay_seconds: 300,
    }, ctx);
    expect(r?.success).toBe(false);
  });

  it('rejects missing objective', async () => {
    const r = await executeStandardTool('schedule_followup', {
      context_ref: 'ctx-1',
      delay_seconds: 300,
    }, ctx);
    expect(r?.success).toBe(false);
  });
});

describe('cancel_followup', () => {
  it('rejects missing context_ref', async () => {
    const r = await executeStandardTool('cancel_followup', {}, ctx);
    expect(r?.success).toBe(false);
  });
});

// B2-2 fix: vendor-failure path. When the upstream Cloud Tasks enqueue
// throws, the handler must surface failure, not swallow it.
describe('schedule_followup — vendor failure path', () => {
  it('propagates Cloud Tasks enqueue failure as a thrown error (handler does NOT catch — caller wraps)', async () => {
    const { enqueueAgentExecution } = await import('../../infrastructure/cloud-tasks');
    (enqueueAgentExecution as jest.Mock).mockRejectedValueOnce(new Error('cloud tasks 503'));
    // The current schedule_followup handler does not catch the enqueue
    // failure — it rolls back the prior-row update via the transaction and
    // re-throws. The caller (runToolWithTransientRetry) wraps that into a
    // tool result. Asserting "throws" here pins that contract: silently
    // succeeding here would lie about the schedule actually firing.
    await expect(executeStandardTool('schedule_followup', {
      context_ref: 'ctx-1',
      objective: 'Check on the thing',
      delay_seconds: 300,
    }, ctx)).rejects.toThrow(/cloud tasks 503/);
  });
});

describe('cancel_followup — vendor failure path', () => {
  it('does not throw when the underlying Cloud Tasks cancel fails (NOT_FOUND is OK)', async () => {
    const { cancelScheduledAgentExecution } = await import('../../infrastructure/cloud-tasks');
    (cancelScheduledAgentExecution as jest.Mock).mockRejectedValueOnce(new Error('cloud tasks unavailable'));
    // cancel_followup is documented as best-effort on the Cloud Tasks side;
    // the DB-side cancel is the source of truth. So the handler returning
    // success even when the task delete fails is expected. We're verifying
    // it doesn't BLOW UP — the resilience contract.
    const r = await executeStandardTool('cancel_followup', { context_ref: 'ctx-1' }, ctx);
    // Either outcome is acceptable; the contract is "don't throw".
    expect(r).not.toBeNull();
  });
});
