// F3 / F4 — per-routine objective resolution, chaining, and the overlap guard.
//
// The defect these cover is that every companion Cloud Scheduler job posts to
// ONE endpoint. Without reading the label off the body, all of an agent's
// routines ran the top-level objective, and per-routine identity did not exist
// on this path at all — which also meant nothing could tell whether a routine
// was already running.

import type { Request, Response } from 'express';

const query = jest.fn();
const executeTask = jest.fn();
const enqueueAgentExecution = jest.fn();
const createThread = jest.fn();
const updateThreadStatus = jest.fn();
const getLatestCompletedByLabel = jest.fn();
const buildPriorInvocationSummary = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPoolForService: () => ({ query: (...a: unknown[]) => query(...a) }),
  getPool: () => ({ query: (...a: unknown[]) => query(...a) }),
  withTenantScope: jest.fn(),
}));
jest.mock('../../infrastructure/oidc', () => ({ verifyOidcToken: async () => true }));
jest.mock('../../infrastructure/safe-trace-context', () => ({ setTraceContext: jest.fn() }));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../infrastructure/cloud-tasks', () => ({
  enqueueAgentExecution: (...a: unknown[]) => enqueueAgentExecution(...a),
}));
jest.mock('../../agent-execution/service', () => ({
  agentExecutionService: { executeTask: (...a: unknown[]) => executeTask(...a) },
  buildPriorInvocationSummary: (...a: unknown[]) => buildPriorInvocationSummary(...a),
}));
jest.mock('../../invocations/service', () => ({
  invocationsService: {
    createThread: (...a: unknown[]) => createThread(...a),
    updateThreadStatus: (...a: unknown[]) => updateThreadStatus(...a),
    getLatestCompletedByLabel: (...a: unknown[]) => getLatestCompletedByLabel(...a),
  },
}));
jest.mock('../../agent-execution/terminal-state', () => ({
  resolveTerminalState: () => 'success',
  THREAD_STATUS_BY_TERMINAL: { success: 'completed' },
}));

 
const { scheduledInvokeHandler: router } = require('../scheduled-invoke-handler');

/** A POST route handler by path. Both scheduler targets live in this file:
 *  `/scheduled-enqueue` is what current jobs point at, `/scheduled-invoke` is
 *  the direct-execute path older jobs still use. Both must honor the label. */
function handler(path: string): (req: Request, res: Response) => Promise<unknown> {
  const layer = router.stack.find(
    (l: { route?: { path: string; methods: Record<string, boolean> } }) =>
      l.route?.path === path && l.route?.methods.post,
  );
  return layer.route.stack[0].handle;
}

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: unknown) { res.body = payload; return res; },
  };
  return res as unknown as Response & { statusCode: number; body: any };
}

const TRIGGER_CONFIG = {
  objective: 'the top-level objective',
  companionCrons: [
    { label: 'morning-sweep', cronExpr: '0 9 * * *', objective: 'sweep the inbox' },
    { label: 'afternoon-report', cronExpr: '0 15 * * *', objective: 'write the report', contextFromLabel: 'morning-sweep' },
    { label: 'no-objective', cronExpr: '0 1 * * *' },
  ],
};

/** Route the handler's queries by SQL shape, so a test only states the rows it
 *  cares about. `overlap` decides whether a run is reported in flight. */
function primeQueries(opts: { overlap?: boolean } = {}) {
  query.mockReset();
  query.mockImplementation(async (sql: string) => {
    if (/FROM agents a/.test(sql)) {
      return { rows: [{ lifecycle: 'ACTIVE', agent_execution_allowed: true, operational_status: 'active' }] };
    }
    if (/SELECT trigger_config, name FROM agents/.test(sql)) {
      return { rows: [{ trigger_config: TRIGGER_CONFIG, name: 'Ops' }] };
    }
    if (/FROM invocations/.test(sql)) {
      return { rows: opts.overlap ? [{ '?column?': 1 }] : [] };
    }
    return { rows: [] };
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  primeQueries();
  createThread.mockResolvedValue({ id: 'thread-1' });
  executeTask.mockResolvedValue({ success: true, toolCallsExecuted: 0, reasoningSteps: 0 });
  updateThreadStatus.mockResolvedValue(undefined);
  getLatestCompletedByLabel.mockResolvedValue(null);
  buildPriorInvocationSummary.mockReturnValue('\n<prior-run>\nLast run: success\n</prior-run>');
});

async function invoke(body: Record<string, unknown>) {
  const res = fakeRes();
  await handler('/scheduled-invoke')({ body, headers: {} } as unknown as Request, res);
  return res;
}

async function enqueue(body: Record<string, unknown>) {
  const res = fakeRes();
  await handler('/scheduled-enqueue')({ body, headers: {} } as unknown as Request, res);
  return res;
}

describe('per-routine objective (F3)', () => {
  it('runs the labelled routine objective, not the top-level one', async () => {
    await invoke({ tenantId: 'tenant-1', agentId: 'agent-1', triggeredByLabel: 'companion:morning-sweep' });
    expect(executeTask).toHaveBeenCalledWith(expect.objectContaining({ objective: 'sweep the inbox' }));
  });

  it('falls back to the top-level objective for the primary schedule', async () => {
    await invoke({ tenantId: 'tenant-1', agentId: 'agent-1' });
    expect(executeTask).toHaveBeenCalledWith(expect.objectContaining({ objective: 'the top-level objective' }));
  });

  it('falls back to the top-level objective for a routine that declares none', async () => {
    await invoke({ tenantId: 'tenant-1', agentId: 'agent-1', triggeredByLabel: 'companion:no-objective' });
    expect(executeTask).toHaveBeenCalledWith(expect.objectContaining({ objective: 'the top-level objective' }));
  });

  it('ignores a label that matches no routine', async () => {
    await invoke({ tenantId: 'tenant-1', agentId: 'agent-1', triggeredByLabel: 'companion:ghost' });
    expect(executeTask).toHaveBeenCalledWith(expect.objectContaining({ objective: 'the top-level objective' }));
  });

  it('passes the label through to the run, so attribution survives', async () => {
    await invoke({ tenantId: 'tenant-1', agentId: 'agent-1', triggeredByLabel: 'companion:morning-sweep' });
    expect(executeTask).toHaveBeenCalledWith(
      expect.objectContaining({ triggeredByLabel: 'companion:morning-sweep' }),
    );
  });
});

describe('routine chaining (F3)', () => {
  it('folds in the named sibling last completed run', async () => {
    getLatestCompletedByLabel.mockResolvedValue({ id: 'inv-9', completedAt: new Date() });
    await invoke({ tenantId: 'tenant-1', agentId: 'agent-1', triggeredByLabel: 'companion:afternoon-report' });

    expect(getLatestCompletedByLabel).toHaveBeenCalledWith('tenant-1', 'agent-1', 'companion:morning-sweep');
    const objective = executeTask.mock.calls[0][0].objective as string;
    expect(objective).toContain('write the report');
    expect(objective).toContain('<prior-run>');
  });

  it('runs unchanged when the sibling has never completed', async () => {
    getLatestCompletedByLabel.mockResolvedValue(null);
    await invoke({ tenantId: 'tenant-1', agentId: 'agent-1', triggeredByLabel: 'companion:afternoon-report' });
    expect(executeTask.mock.calls[0][0].objective).toBe('write the report');
  });

  it('runs the tick anyway when the sibling lookup fails', async () => {
    getLatestCompletedByLabel.mockRejectedValue(new Error('db down'));
    await invoke({ tenantId: 'tenant-1', agentId: 'agent-1', triggeredByLabel: 'companion:afternoon-report' });
    expect(executeTask).toHaveBeenCalled();
    expect(executeTask.mock.calls[0][0].objective).toBe('write the report');
  });

  it('does not look for a sibling when the routine declares no chain', async () => {
    await invoke({ tenantId: 'tenant-1', agentId: 'agent-1', triggeredByLabel: 'companion:morning-sweep' });
    expect(getLatestCompletedByLabel).not.toHaveBeenCalled();
  });
});

describe('overlap guard (F4)', () => {
  it('skips the tick when the previous run is still in flight', async () => {
    primeQueries({ overlap: true });
    const res = await invoke({ tenantId: 'tenant-1', agentId: 'agent-1', triggeredByLabel: 'companion:morning-sweep' });

    expect(executeTask).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200); // never a retryable error to Cloud Scheduler
    expect(res.body).toEqual(expect.objectContaining({ skipped: true }));
  });

  it('does not queue a backlog — the skipped tick is simply dropped', async () => {
    primeQueries({ overlap: true });
    await invoke({ tenantId: 'tenant-1', agentId: 'agent-1', triggeredByLabel: 'companion:morning-sweep' });
    expect(enqueueAgentExecution).not.toHaveBeenCalled();
  });

  it('runs when nothing is in flight', async () => {
    primeQueries({ overlap: false });
    await invoke({ tenantId: 'tenant-1', agentId: 'agent-1', triggeredByLabel: 'companion:morning-sweep' });
    expect(executeTask).toHaveBeenCalled();
  });

  it('leaves the primary schedule alone — it carries no routine identity', async () => {
    primeQueries({ overlap: true });
    await invoke({ tenantId: 'tenant-1', agentId: 'agent-1' });
    // The overlap row exists, but an unlabelled fire must not be blocked by
    // some other routine of the same agent.
    expect(executeTask).toHaveBeenCalled();
  });

  it('runs the tick when the overlap check itself fails', async () => {
    query.mockImplementation(async (sql: string) => {
      if (/FROM agents a/.test(sql)) {
        return { rows: [{ lifecycle: 'ACTIVE', agent_execution_allowed: true, operational_status: 'active' }] };
      }
      if (/SELECT trigger_config, name FROM agents/.test(sql)) {
        return { rows: [{ trigger_config: TRIGGER_CONFIG, name: 'Ops' }] };
      }
      if (/FROM invocations/.test(sql)) throw new Error('db down');
      return { rows: [] };
    });
    await invoke({ tenantId: 'tenant-1', agentId: 'agent-1', triggeredByLabel: 'companion:morning-sweep' });
    expect(executeTask).toHaveBeenCalled();
  });
});

// The enqueue route is what live Cloud Scheduler jobs target, so the same
// guarantees have to hold one hop earlier — before a task is queued.
describe('the enqueue route', () => {
  beforeEach(() => {
    enqueueAgentExecution.mockResolvedValue({ taskName: 'task-1' });
  });

  it('enqueues the labelled routine objective and carries the label', async () => {
    await enqueue({ tenantId: 'tenant-1', agentId: 'agent-1', triggeredByLabel: 'companion:morning-sweep' });
    expect(enqueueAgentExecution).toHaveBeenCalledWith(
      'tenant-1',
      'agent-1',
      expect.objectContaining({
        objective: 'sweep the inbox',
        triggeredByLabel: 'companion:morning-sweep',
      }),
    );
  });

  it('folds a chained sibling in before enqueueing', async () => {
    getLatestCompletedByLabel.mockResolvedValue({ id: 'inv-9', completedAt: new Date() });
    await enqueue({ tenantId: 'tenant-1', agentId: 'agent-1', triggeredByLabel: 'companion:afternoon-report' });
    const opts = enqueueAgentExecution.mock.calls[0][2] as { objective: string };
    expect(opts.objective).toContain('<prior-run>');
  });

  it('does not enqueue when the previous run is still in flight', async () => {
    primeQueries({ overlap: true });
    const res = await enqueue({ tenantId: 'tenant-1', agentId: 'agent-1', triggeredByLabel: 'companion:morning-sweep' });
    expect(enqueueAgentExecution).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(expect.objectContaining({ skipped: true }));
  });
});
