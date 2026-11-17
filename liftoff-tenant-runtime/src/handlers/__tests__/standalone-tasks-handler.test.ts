// Standalone task handlers — unit tests (plan v6.1 Phase 0.4).
// enqueue-standalone: validation, 202 + taskId, dedup on ALREADY_EXISTS,
// receiverPath/receiverBody wiring through the existing enqueue helper.
// execute-standalone: executeTask contract (onConflict 'defer', synthesized
// workflowId, NO progressWorkflow), duplicate dedup, malformed-drop.

import express from 'express';

const mockEnqueue = jest.fn();
jest.mock('../../infrastructure/cloud-tasks', () => ({
  enqueueAgentExecution: (...args: unknown[]) => mockEnqueue(...args),
}));

const mockExecuteTask = jest.fn();
const mockProgressWorkflow = jest.fn();
jest.mock('../../agent-execution/service', () => ({
  agentExecutionService: {
    executeTask: (...args: unknown[]) => mockExecuteTask(...args),
    progressWorkflow: (...args: unknown[]) => mockProgressWorkflow(...args),
  },
}));

jest.mock('../../agent-lifecycle/resolve-runtime-agent-id', () => ({
  resolveRuntimeAgentId: jest.fn(async (_tenantId: string, internalId: string) =>
    internalId === '55555555-5555-4555-8555-555555555555'
      ? '66666666-6666-4666-8666-666666666666'
      : internalId),
}));

jest.mock('../../security/service-auth', () => ({
  requireServiceAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../cloud-tasks-handler', () => ({
  verifyCloudTasksOidc: jest.fn().mockResolvedValue(true),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

jest.mock('../../infrastructure/safe-trace-context', () => ({
  setTraceContext: jest.fn(),
}));

import { standaloneTasksHandler } from '../standalone-tasks-handler';

const PAYLOAD = {
  tenantId: '11111111-1111-4111-8111-111111111111',
  agentId: '55555555-5555-4555-8555-555555555555',
  taskId: '77777777-7777-4777-8777-777777777777',
  objective: 'do the thing',
  inputData: { a: 1 },
  triggeredBy: 'human',
  triggeredByLabel: 'claude_code:mcp-delegate',
  triggerKey: 'mcp-delegate:key-1',
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/tasks', standaloneTasksHandler);
  return app;
}

// One server, one request, fully torn down before resolving.
//
// `connection: close` and the awaited `server.close()` are both load-bearing.
// An ephemeral port gets recycled to a later test's server, and a pooled
// keep-alive socket for `127.0.0.1:<port>` would then carry this request to
// the wrong app (404) or to a dead socket (test timeout). setup.ts disables
// pooling globally; this call site states the requirement locally too, because
// the failure it prevents is silent and lands in an unrelated suite.
async function post(app: express.Express, path: string, body: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
  const server = app.listen(0);
  await new Promise<void>((r) => server.once('listening', () => r()));
  const { port } = server.address() as { port: number };
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', connection: 'close' },
      body: JSON.stringify(body),
    });
    const b = await res.json().catch(() => ({}));
    return { status: res.status, body: b as Record<string, unknown> };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

beforeEach(() => {
  jest.clearAllMocks();
  mockEnqueue.mockResolvedValue({ taskName: 'projects/x/tasks/t', scheduleKey: PAYLOAD.taskId, contextRef: null });
  mockExecuteTask.mockResolvedValue({ success: true });
});

describe('POST /api/tasks/enqueue-standalone', () => {
  it('validates and self-enqueues via the existing helper with receiver overrides', async () => {
    const res = await post(buildApp(), '/api/tasks/enqueue-standalone', PAYLOAD);
    expect(res.status).toBe(202);
    expect(res.body.taskId).toBe(PAYLOAD.taskId);
    expect(mockEnqueue).toHaveBeenCalledWith(PAYLOAD.tenantId, PAYLOAD.agentId, expect.objectContaining({
      receiverPath: '/api/tasks/execute-standalone',
      receiverBody: expect.objectContaining({ triggerKey: PAYLOAD.triggerKey }),
      scheduleKey: PAYLOAD.taskId,
    }));
  });

  it('400s an invalid payload (audit-string triggeredBy is NOT accepted)', async () => {
    const res = await post(buildApp(), '/api/tasks/enqueue-standalone', { ...PAYLOAD, triggeredBy: 'human:unknown' });
    expect(res.status).toBe(400);
    expect(mockEnqueue).not.toHaveBeenCalled();
  });

  it('treats Cloud Tasks ALREADY_EXISTS as accepted (dedup)', async () => {
    mockEnqueue.mockRejectedValueOnce(Object.assign(new Error('exists'), { code: 6 }));
    const res = await post(buildApp(), '/api/tasks/enqueue-standalone', PAYLOAD);
    expect(res.status).toBe(202);
    expect(res.body.deduplicated).toBe(true);
  });

  it('500s a real enqueue failure', async () => {
    mockEnqueue.mockRejectedValueOnce(new Error('queue down'));
    const res = await post(buildApp(), '/api/tasks/enqueue-standalone', PAYLOAD);
    expect(res.status).toBe(500);
  });
});

describe('POST /api/tasks/execute-standalone', () => {
  it('executes with onConflict defer, the supplied triggerKey, a synthesized workflowId — and NEVER progresses a workflow', async () => {
    const res = await post(buildApp(), '/api/tasks/execute-standalone', PAYLOAD);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(true);
    expect(mockExecuteTask).toHaveBeenCalledWith(expect.objectContaining({
      onConflict: 'defer',
      triggerKey: PAYLOAD.triggerKey,
      taskId: PAYLOAD.taskId,
      triggeredBy: 'human',
      inputData: { a: 1 },
      // PB internal id translated to the runtime agents.id at the boundary
      agentId: '66666666-6666-4666-8666-666666666666',
    }));
    const input = mockExecuteTask.mock.calls[0][0] as { workflowId: string };
    expect(input.workflowId).toMatch(/^[0-9a-f-]{36}$/);
    expect(input.workflowId).not.toBe(PAYLOAD.taskId);
    expect(mockProgressWorkflow).not.toHaveBeenCalled();
  });

  it('200-dedups a duplicate delivery in flight', async () => {
    mockExecuteTask.mockResolvedValueOnce({ success: false, error: 'duplicate_delivery_in_flight' });
    const res = await post(buildApp(), '/api/tasks/execute-standalone', PAYLOAD);
    expect(res.status).toBe(200);
    expect(res.body.deduplicated).toBe(true);
  });

  it('drops a malformed payload with 200 (permanent — no Cloud Tasks retry)', async () => {
    const res = await post(buildApp(), '/api/tasks/execute-standalone', { nope: true });
    expect(res.status).toBe(200);
    expect(res.body.dropped).toBe(true);
    expect(mockExecuteTask).not.toHaveBeenCalled();
  });

  it('500s an execution throw so Cloud Tasks retries (triggerKey idempotency replays)', async () => {
    mockExecuteTask.mockRejectedValueOnce(new Error('transient'));
    const res = await post(buildApp(), '/api/tasks/execute-standalone', PAYLOAD);
    expect(res.status).toBe(500);
  });
});
