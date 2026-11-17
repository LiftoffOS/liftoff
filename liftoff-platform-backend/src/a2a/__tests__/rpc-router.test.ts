// A2A RPC Router — unit tests
// Covers: SendMessage, GetTask (a2a_task_registry ownership), CancelTask,
// unknown method, auth, invalid agentId/tenantId.
//
// Auth model: X-Service-Token validated against external_agents.inbound_service_token_hash.
// Query order per request: (1) service token lookup, (2) agent lookup, (3) method query.

import express from 'express';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockPoolQuery = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(() => ({ query: mockPoolQuery })),
  // The rpc-router runs every query under withTenantScope. The fake client
  // exposed to the callback delegates query() to the same mock the tests
  // already set up via mockPoolQuery, so existing mockResolvedValueOnce
  // chains keep working unchanged.
  withTenantScope: jest.fn(async (_tenantId: string, fn: (client: { query: typeof mockPoolQuery }) => unknown) => {
    return fn({ query: mockPoolQuery });
  }),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockEnqueueAgentTask = jest.fn().mockResolvedValue(undefined);
const mockCancelAgentTask = jest.fn().mockResolvedValue(undefined);

jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: {
    enqueueAgentTask: (...args: unknown[]) => mockEnqueueAgentTask(...args),
    cancelAgentTask: (...args: unknown[]) => mockCancelAgentTask(...args),
  },
}));

jest.mock('../../internal-agent-oversight/service', () => ({
  oversightService: {
    getOrCreateOversightSettings: jest.fn().mockResolvedValue({
      tenantId: '11111111-1111-1111-1111-111111111111',
      currentVersion: 1,
      autonomy: 'balanced',
      escalation: 'important',
      sensitiveWork: {},
      communication: 'review',
      createdAt: new Date(),
      updatedAt: new Date(),
    }),
  },
}));

import { a2aRpcRouter } from '../rpc-router';

// ── Test app ───────────────────────────────────────────────────────────────

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/a2a', a2aRpcRouter);
  return app;
}

const SERVICE_TOKEN = 'test-service-token-abc';
const CALLER_ID = '55555555-5555-5555-5555-555555555555';

function makeRequest(
  app: express.Express,
  agentId: string,
  tenantId: string,
  body: unknown,
  overrideHeaders: Record<string, string> = {},
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      const url = `http://127.0.0.1:${addr.port}/api/a2a/agents/${agentId}/rpc?tenantId=${tenantId}`;
      fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Service-Token': SERVICE_TOKEN,
          ...overrideHeaders,
        },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          const b = await res.json().catch(() => ({}));
          server.close();
          resolve({ status: res.status, body: b as Record<string, unknown> });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_ID  = '22222222-2222-2222-2222-222222222222';
const TASK_ID   = '33333333-3333-3333-3333-333333333333';
const CTX_ID    = '44444444-4444-4444-4444-444444444444';

// Canned DB responses for the three query layers
const AUTH_ROW  = { rows: [{ id: CALLER_ID }] };          // service token lookup
const AGENT_ROW = { rows: [{ id: AGENT_ID, role: 'HR' }] }; // agent lookup
const TASK_ROW  = { rows: [{ task_id: TASK_ID, agent_id: AGENT_ID }] }; // a2a_task_registry

function sendMessageBody(id = 1, text = 'run payroll') {
  return {
    jsonrpc: '2.0', id, method: 'SendMessage',
    params: { message: { role: 'user', messageId: 'msg-1', contextId: CTX_ID, parts: [{ text }] } },
  };
}

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
});

// ── Input validation ───────────────────────────────────────────────────────

describe('Input validation', () => {
  it('returns -32602 for invalid agentId', async () => {
    // UUID validation runs before auth — no DB mocks needed
    const app = buildApp();
    const res = await makeRequest(app, 'not-a-uuid', TENANT_ID, sendMessageBody());
    expect(res.status).toBe(400);
    expect((res.body as { error?: { code?: number } }).error?.code).toBe(-32602);
  });

  it('returns -32602 when tenantId is missing', async () => {
    // tenantId validation runs before auth — no DB mocks needed
    const app = buildApp();
    const res = await makeRequest(app, AGENT_ID, '', sendMessageBody());
    expect(res.status).toBe(400);
    expect((res.body as { error?: { code?: number } }).error?.code).toBe(-32602);
  });

  it('returns -32001 when X-Service-Token is absent', async () => {
    // Pass no token — auth returns -32001 before any DB query
    const app = buildApp();
    const res = await makeRequest(app, AGENT_ID, TENANT_ID, sendMessageBody(), { 'X-Service-Token': '' });
    expect((res.body as { error?: { code?: number } }).error?.code).toBe(-32001);
  });

  it('returns -32600 when method is missing', async () => {
    mockPoolQuery.mockResolvedValueOnce(AUTH_ROW); // service token lookup
    const app = buildApp();
    const res = await makeRequest(app, AGENT_ID, TENANT_ID, { jsonrpc: '2.0', id: 1 });
    expect((res.body as { error?: { code?: number } }).error?.code).toBe(-32600);
  });

  it('returns -32001 when agent not found in tenant', async () => {
    mockPoolQuery.mockResolvedValueOnce(AUTH_ROW);          // service token lookup
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });       // agent not in tenant
    const app = buildApp();
    const res = await makeRequest(app, AGENT_ID, TENANT_ID, sendMessageBody());
    expect((res.body as { error?: { code?: number } }).error?.code).toBe(-32001);
  });
});

// ── SendMessage ────────────────────────────────────────────────────────────

describe('SendMessage', () => {
  it('enqueues task and returns submitted status', async () => {
    mockPoolQuery.mockResolvedValueOnce(AUTH_ROW);          // service token lookup
    mockPoolQuery.mockResolvedValueOnce(AGENT_ROW);         // agent lookup
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });       // INSERT a2a_task_registry
    const app = buildApp();
    const res = await makeRequest(app, AGENT_ID, TENANT_ID, sendMessageBody());

    expect(res.status).toBe(200);
    const result = (res.body as { result?: { task?: { status?: string; id?: string; contextId?: string } } }).result;
    expect(result?.task?.status).toBe('submitted');
    expect(result?.task?.id).toBeDefined();
    expect(result?.task?.contextId).toBe(CTX_ID);
    expect(mockEnqueueAgentTask).toHaveBeenCalledWith(TENANT_ID, AGENT_ID, expect.objectContaining({
      objective: 'run payroll',
      triggeredBy: 'a2a',
    }));
  });

  it('returns -32602 when message text is missing', async () => {
    mockPoolQuery.mockResolvedValueOnce(AUTH_ROW);
    mockPoolQuery.mockResolvedValueOnce(AGENT_ROW);
    const app = buildApp();
    const res = await makeRequest(app, AGENT_ID, TENANT_ID, {
      jsonrpc: '2.0', id: 1, method: 'SendMessage',
      params: { message: { role: 'user', parts: [{}] } }, // no text
    });
    expect((res.body as { error?: { code?: number } }).error?.code).toBe(-32602);
  });

  it('generates contextId when not provided in message', async () => {
    mockPoolQuery.mockResolvedValueOnce(AUTH_ROW);
    mockPoolQuery.mockResolvedValueOnce(AGENT_ROW);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const app = buildApp();
    const res = await makeRequest(app, AGENT_ID, TENANT_ID, {
      jsonrpc: '2.0', id: 1, method: 'SendMessage',
      params: { message: { role: 'user', parts: [{ text: 'hello' }] } }, // no contextId
    });
    const result = (res.body as { result?: { task?: { contextId?: string } } }).result;
    expect(result?.task?.contextId).toBeDefined();
  });

  // M2 atomicity test: when the runtime enqueue fails, the registry row that
  // was just inserted must be deleted so GetTask doesn't return a phantom task
  // that no runtime is processing.
  it('rolls back a2a_task_registry row when tenantRuntimeClient.enqueueAgentTask fails', async () => {
    mockPoolQuery.mockResolvedValueOnce(AUTH_ROW);                       // service token lookup
    mockPoolQuery.mockResolvedValueOnce(AGENT_ROW);                      // agent lookup
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });      // INSERT a2a_task_registry succeeds
    mockEnqueueAgentTask.mockRejectedValueOnce(new Error('runtime down'));
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });      // DELETE a2a_task_registry (rollback)

    const app = buildApp();
    const res = await makeRequest(app, AGENT_ID, TENANT_ID, sendMessageBody());

    expect(res.status).toBe(200);
    expect((res.body as { error?: { code?: number } }).error?.code).toBe(-32603);

    // INSERT then DELETE — the rollback fires after the enqueue throws.
    const insertCall = mockPoolQuery.mock.calls.find((c) =>
      typeof c[0] === 'string' && c[0].includes('INSERT INTO a2a_task_registry'),
    );
    const deleteCall = mockPoolQuery.mock.calls.find((c) =>
      typeof c[0] === 'string' && c[0].includes('DELETE FROM a2a_task_registry'),
    );
    expect(insertCall).toBeDefined();
    expect(deleteCall).toBeDefined();
    expect(deleteCall![1]).toEqual(expect.arrayContaining([TENANT_ID]));
  });

  // M2 edge case: if the rollback DELETE itself also fails, the original
  // enqueue error should still propagate to the caller (best-effort rollback).
  it('still returns -32603 when both enqueue AND rollback DELETE fail', async () => {
    mockPoolQuery.mockResolvedValueOnce(AUTH_ROW);
    mockPoolQuery.mockResolvedValueOnce(AGENT_ROW);
    mockPoolQuery.mockResolvedValueOnce({ rows: [], rowCount: 1 });      // INSERT
    mockEnqueueAgentTask.mockRejectedValueOnce(new Error('runtime down'));
    mockPoolQuery.mockRejectedValueOnce(new Error('db blip'));            // DELETE fails

    const app = buildApp();
    const res = await makeRequest(app, AGENT_ID, TENANT_ID, sendMessageBody());
    expect((res.body as { error?: { code?: number } }).error?.code).toBe(-32603);
  });
});

// ── GetTask ────────────────────────────────────────────────────────────────

describe('GetTask', () => {
  function getTaskBody(taskId = TASK_ID, id = 2) {
    return { jsonrpc: '2.0', id, method: 'GetTask', params: { id: taskId } };
  }

  it('returns submitted status when task found in registry', async () => {
    // GetTask always returns 'submitted' — live status tracked in tenant runtime
    mockPoolQuery.mockResolvedValueOnce(AUTH_ROW);
    mockPoolQuery.mockResolvedValueOnce(AGENT_ROW);
    mockPoolQuery.mockResolvedValueOnce(TASK_ROW); // a2a_task_registry found
    const app = buildApp();
    const res = await makeRequest(app, AGENT_ID, TENANT_ID, getTaskBody());
    const task = (res.body as { result?: { task?: { status?: string } } }).result?.task;
    expect(task?.status).toBe('submitted');
  });

  it('returns -32001 when task not found or access denied', async () => {
    mockPoolQuery.mockResolvedValueOnce(AUTH_ROW);
    mockPoolQuery.mockResolvedValueOnce(AGENT_ROW);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // not in registry / not owner
    const app = buildApp();
    const res = await makeRequest(app, AGENT_ID, TENANT_ID, getTaskBody());
    expect((res.body as { error?: { code?: number } }).error?.code).toBe(-32001);
  });

  it('enforces ownership — registry query binds requester_key_id and agent_id', async () => {
    mockPoolQuery.mockResolvedValueOnce(AUTH_ROW);
    mockPoolQuery.mockResolvedValueOnce(AGENT_ROW);
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const app = buildApp();
    await makeRequest(app, AGENT_ID, TENANT_ID, getTaskBody());

    // Third call is the a2a_task_registry ownership query
    const registryQuery = mockPoolQuery.mock.calls[2];
    expect(registryQuery[1][2]).toBe(CALLER_ID);  // $3 = requester_key_id from auth
    expect(registryQuery[1][3]).toBe(AGENT_ID);   // $4 = agentId from path
  });

  it('returns -32602 when task ID exceeds max length', async () => {
    mockPoolQuery.mockResolvedValueOnce(AUTH_ROW);
    mockPoolQuery.mockResolvedValueOnce(AGENT_ROW);
    const app = buildApp();
    const longId = 'a'.repeat(257); // > 256 chars triggers length guard
    const res = await makeRequest(app, AGENT_ID, TENANT_ID, { jsonrpc: '2.0', id: 2, method: 'GetTask', params: { id: longId } });
    expect((res.body as { error?: { code?: number } }).error?.code).toBe(-32602);
  });
});

// ── CancelTask ─────────────────────────────────────────────────────────────

describe('CancelTask', () => {
  it('returns best-effort failed status', async () => {
    mockPoolQuery.mockResolvedValueOnce(AUTH_ROW);   // service token
    mockPoolQuery.mockResolvedValueOnce(AGENT_ROW);  // agent lookup
    mockPoolQuery.mockResolvedValueOnce(TASK_ROW);   // ownership check
    const app = buildApp();
    const res = await makeRequest(app, AGENT_ID, TENANT_ID, {
      jsonrpc: '2.0', id: 3, method: 'CancelTask', params: { id: TASK_ID },
    });
    expect(res.status).toBe(200);
    const task = (res.body as { result?: { task?: { status?: string } } }).result?.task;
    expect(task?.status).toBe('failed');
  });
});

// ── Unknown method ─────────────────────────────────────────────────────────

describe('Unknown method', () => {
  it('returns -32601 Method not found', async () => {
    mockPoolQuery.mockResolvedValueOnce(AUTH_ROW);
    mockPoolQuery.mockResolvedValueOnce(AGENT_ROW);
    const app = buildApp();
    const res = await makeRequest(app, AGENT_ID, TENANT_ID, {
      jsonrpc: '2.0', id: 4, method: 'ListTasks',
    });
    expect((res.body as { error?: { code?: number } }).error?.code).toBe(-32601);
  });
});
