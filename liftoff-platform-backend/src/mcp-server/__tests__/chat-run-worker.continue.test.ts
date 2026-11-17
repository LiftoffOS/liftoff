// The continuation worker's handoff: claim → lock → recheck → run, and each
// ordering it has to be safe under. A claim is not the lock, and a person's
// turn can take the lock at any moment, so:
//
//   cancel before claim              → the claim finds no queued row
//   cancel between claim and lock    → the recheck finds the row cancelled
//   a newer person message           → the recheck cancels it, superseded
//   lock busy                        → the row goes back to queued and the
//                                      queue retries; on the last delivery
//                                      the row is failed (lock_busy)
//   the run                          → the loop is given the origin message,
//                                      the account, a continuation input, no
//                                      user message; done on completion

jest.mock('../../common/output-guard', () => ({
  guardOutgoingText: async (text: string) => ({ text, changed: false, kinds: [] }),
}));

import express from 'express';

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../../infrastructure/control-plane-url', () => ({
  getBackendUrl: () => 'https://api-test.example.com',
}));
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: jest.fn(),
  pool: { query: jest.fn() },
}));
jest.mock('../../agent-chat/chat-service', () => ({ runAgentChatTurn: jest.fn() }));
jest.mock('../../liftoff/delegation-runtimes', () => ({ createDelegateRuntime: jest.fn() }));

// The store, statement by statement.
const store = {
  claim: jest.fn(),
  requeue: jest.fn(),
  recheck: jest.fn(),
  running: jest.fn(),
  finish: jest.fn(),
  newer: jest.fn(),
};
jest.mock('../../chat-continuations/store', () => ({
  claimContinuation: (...a: unknown[]) => store.claim(...a),
  requeueContinuation: (...a: unknown[]) => store.requeue(...a),
  recheckClaimedContinuation: (...a: unknown[]) => store.recheck(...a),
  markContinuationRunning: (...a: unknown[]) => store.running(...a),
  finishContinuation: (...a: unknown[]) => store.finish(...a),
  hasNewerPersonMessage: (...a: unknown[]) => store.newer(...a),
  cancelThreadContinuations: jest.fn(),
  threadContinuationStatus: jest.fn(),
}));

const mockTryAcquireLiftoffLock = jest.fn();
const mockReleaseLiftoffLock = jest.fn();
jest.mock('../../liftoff/turn-control', () => ({
  newTurnId: () => 'turn-cont-1',
  tryAcquireTurnLock: (...args: unknown[]) => mockTryAcquireLiftoffLock(...args),
  releaseTurnLock: (...args: unknown[]) => mockReleaseLiftoffLock(...args),
  TurnLockUnavailableError: class TurnLockUnavailableError extends Error {},
}));
jest.mock('../../insights/turn-control', () => ({
  newTurnId: () => 'turn-cont-2',
  tryAcquireTurnLock: jest.fn(),
  releaseTurnLock: jest.fn(),
  TurnLockUnavailableError: class TurnLockUnavailableError extends Error {},
}));
jest.mock('../../liftoff/chat-repository', () => ({ getCallerRole: jest.fn(async () => 'owner') }));
jest.mock('../../insights/chat-repository', () => ({ getCallerRole: jest.fn(async () => 'owner') }));
jest.mock('../../accounts/service', () => ({
  AccountService: class { async getById() { return { id: 'acct-1', firstName: 'Ada', lastName: 'L', email: 'ada@example.com' }; } },
}));
jest.mock('../../accounts/display-name', () => ({ accountDisplayName: () => 'Ada L' }));

let liftoffScriptedEvents: Array<Record<string, unknown>> = [];
const mockRunLiftoffChatTurn = jest.fn(async function* () {
  for (const e of liftoffScriptedEvents) yield e;
});
jest.mock('../../liftoff/chat-service', () => ({
  runLiftoffChatTurn: (...args: unknown[]) => mockRunLiftoffChatTurn(...args),
}));
jest.mock('../../insights/chat-service', () => ({ runInsightsChatTurn: jest.fn() }));

import { mcpChatRunWorkerRouter } from '../chat-run-worker';
import { CONTINUATION_QUEUE_MAX_ATTEMPTS } from '../../chat-continuations/dispatch';

const TENANT = '11111111-1111-1111-1111-111111111111';
const ROW = {
  id: '99999999-9999-4999-8999-999999999999',
  tenantId: TENANT,
  surface: 'liftoff' as const,
  threadId: '66666666-6666-4666-8666-666666666666',
  accountId: 'acct-1',
  originMessageId: '44444444-4444-4444-8444-444444444444',
  ordinal: 1,
  reason: 'MAX_ITERATIONS',
  status: 'claimed' as const,
  workerId: 'w',
};

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/mcp-chat-runs', mcpChatRunWorkerRouter);
  return app;
}

async function post(body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; body: Record<string, unknown> }> {
  const app = buildApp();
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}/api/internal/mcp-chat-runs/continue`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-internal-secret': 'test-secret', ...headers },
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

const BODY = { continuationId: ROW.id, tenantId: TENANT };
const lockHandle = () => ({ turnId: 'turn-cont-1', abortController: new AbortController() });

beforeEach(() => {
  jest.clearAllMocks();
  process.env.INTERNAL_SERVICE_SECRET = 'test-secret';
  liftoffScriptedEvents = [{ type: 'complete', message: { id: 'm-1', content: 'The rest of the summaries.' } }];
  store.claim.mockResolvedValue(ROW);
  store.recheck.mockResolvedValue(ROW);
  store.running.mockResolvedValue(true);
  store.requeue.mockResolvedValue(true);
  store.finish.mockResolvedValue(undefined);
  store.newer.mockResolvedValue(false);
  mockTryAcquireLiftoffLock.mockResolvedValue(lockHandle());
});

describe('the continuation worker', () => {
  it('claim → lock → recheck → running → run: the loop gets the origin, the account, the continuation input, no user message, the deadline; done', async () => {
    const res = await post(BODY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'done' });
    // In order.
    const order = [
      store.claim.mock.invocationCallOrder[0],
      mockTryAcquireLiftoffLock.mock.invocationCallOrder[0],
      store.recheck.mock.invocationCallOrder[0],
      store.newer.mock.invocationCallOrder[0],
      store.running.mock.invocationCallOrder[0],
      mockRunLiftoffChatTurn.mock.invocationCallOrder[0],
      store.finish.mock.invocationCallOrder[0],
      mockReleaseLiftoffLock.mock.invocationCallOrder[0],
    ];
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(store.claim).toHaveBeenCalledWith(TENANT, ROW.id, expect.any(String));
    const workerId = store.claim.mock.calls[0][2];
    expect(store.recheck).toHaveBeenCalledWith(TENANT, ROW.id, workerId);
    expect(store.newer).toHaveBeenCalledWith(TENANT, 'liftoff', ROW.threadId, ROW.originMessageId);
    expect(store.running).toHaveBeenCalledWith(TENANT, ROW.id, workerId);
    const input = mockRunLiftoffChatTurn.mock.calls[0][0] as Record<string, unknown>;
    expect(input).toMatchObject({
      tenantId: TENANT,
      threadId: ROW.threadId,
      accountId: 'acct-1',
      userMessage: '',
      role: 'owner',
      turnId: 'turn-cont-1',
      continuation: { originMessageId: ROW.originMessageId, ordinal: 1 },
    });
    expect(typeof input.deadlineAt).toBe('number');
    expect((input.deadlineAt as number) - Date.now()).toBeLessThanOrEqual(600_000 - 90_000);
    expect(store.finish).toHaveBeenCalledWith(TENANT, ROW.id, workerId, 'done', 'completed');
    expect(mockReleaseLiftoffLock).toHaveBeenCalledTimes(1);
  });

  it('cancel before claim: the claim finds no queued row and nothing runs', async () => {
    store.claim.mockResolvedValue(null);
    const res = await post(BODY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ noop: true });
    expect(mockTryAcquireLiftoffLock).not.toHaveBeenCalled();
    expect(mockRunLiftoffChatTurn).not.toHaveBeenCalled();
  });

  it('cancel between claim and lock: the recheck finds the row gone, the lock is released, nothing runs', async () => {
    store.recheck.mockResolvedValue(null);
    const res = await post(BODY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ noop: true, reason: 'not_claimed' });
    expect(mockRunLiftoffChatTurn).not.toHaveBeenCalled();
    expect(store.running).not.toHaveBeenCalled();
    expect(mockReleaseLiftoffLock).toHaveBeenCalledTimes(1);
  });

  it('a newer person message: the row is cancelled as superseded under the lock, and nothing runs', async () => {
    store.newer.mockResolvedValue(true);
    const res = await post(BODY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'cancelled', reason: 'superseded' });
    expect(store.finish).toHaveBeenCalledWith(TENANT, ROW.id, expect.any(String), 'cancelled', 'superseded');
    expect(mockRunLiftoffChatTurn).not.toHaveBeenCalled();
    expect(mockReleaseLiftoffLock).toHaveBeenCalledTimes(1);
  });

  it('lock busy: the row goes back to queued and the delivery answers a retryable status', async () => {
    mockTryAcquireLiftoffLock.mockResolvedValue(null);
    const res = await post(BODY, { 'x-cloudtasks-taskretrycount': '3' });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ retry: true, reason: 'lock_busy' });
    expect(store.requeue).toHaveBeenCalledWith(TENANT, ROW.id, expect.any(String));
    expect(store.finish).not.toHaveBeenCalled();
    expect(mockRunLiftoffChatTurn).not.toHaveBeenCalled();
  });

  it('lock busy on the last delivery: the row is failed (lock_busy) and the queue is told to stop', async () => {
    mockTryAcquireLiftoffLock.mockResolvedValue(null);
    const res = await post(BODY, { 'x-cloudtasks-taskretrycount': String(CONTINUATION_QUEUE_MAX_ATTEMPTS - 1) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'failed', reason: 'lock_busy' });
    expect(store.finish).toHaveBeenCalledWith(TENANT, ROW.id, expect.any(String), 'failed', 'lock_busy');
    expect(store.requeue).not.toHaveBeenCalled();
  });

  it('a thrown turn fails the row with the reason, and releases the lock', async () => {
    // eslint-disable-next-line require-yield
    mockRunLiftoffChatTurn.mockImplementationOnce(async function* () { throw new Error('boom'); });
    const res = await post(BODY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'failed' });
    expect(store.finish).toHaveBeenCalledWith(TENANT, ROW.id, expect.any(String), 'failed', 'turn_exception: boom');
    expect(mockReleaseLiftoffLock).toHaveBeenCalledTimes(1);
  });

  it('a malformed task is dropped without a retry', async () => {
    const res = await post({ tenantId: TENANT });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ dropped: true });
    expect(store.claim).not.toHaveBeenCalled();
  });
});
