// The Chief AI Officer continuation task handler: claim → the thread free →
// recheck → running → run, and each ordering it has to be safe under.

const store = {
  claim: jest.fn(), requeue: jest.fn(), recheck: jest.fn(), running: jest.fn(), finish: jest.fn(), newer: jest.fn(),
};
jest.mock('../workforce-plans/chat-continuations.js', () => ({
  ...jest.requireActual('../workforce-plans/chat-continuations.js'),
  claimContinuation: (...a: unknown[]) => store.claim(...a),
  requeueContinuation: (...a: unknown[]) => store.requeue(...a),
  recheckClaimedContinuation: (...a: unknown[]) => store.recheck(...a),
  markContinuationRunning: (...a: unknown[]) => store.running(...a),
  finishContinuation: (...a: unknown[]) => store.finish(...a),
  hasNewerPersonMessage: (...a: unknown[]) => store.newer(...a),
}));
const mockFindLiveTurnId = jest.fn();
jest.mock('../workforce-plans/turn-signal-repository.js', () => ({
  findLiveTurnId: (...a: unknown[]) => mockFindLiveTurnId(...a),
}));
const mockProfiles = jest.fn();
jest.mock('../workforce-plans/account-profiles.js', () => ({
  getAccountProfiles: (...a: unknown[]) => mockProfiles(...a),
}));
let scripted: Array<Record<string, unknown>> = [];
const mockRunTurn: jest.Mock = jest.fn(async function* () { for (const e of scripted) yield e; });
jest.mock('../workforce-plans/chat-service.js', () => ({
  runCAIOChatTurn: (input: unknown) => mockRunTurn(input),
}));
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    verifyIdToken: jest.fn(async () => ({ getPayload: () => ({ email: 'wf@test.iam' }) })),
  })),
}));
jest.mock('../infrastructure/logging.js', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../infrastructure/rls.js', () => ({ withTenantContext: jest.fn() }));

import Fastify from 'fastify';
import { registerChatContinuationTaskRoutes } from '../workforce-plans/chat-continuation-task-handler.js';
import { CONTINUATION_QUEUE_MAX_ATTEMPTS } from '../workforce-plans/chat-continuations.js';

const TENANT = '22222222-2222-4222-8222-222222222222';
const ROW = {
  id: '99999999-9999-4999-8999-999999999999', tenantId: TENANT, threadId: '11111111-1111-4111-8111-111111111111',
  accountId: '33333333-3333-4333-8333-333333333333', originMessageId: '44444444-4444-4444-8444-444444444444',
  ordinal: 1, reason: 'MAX_ITERATIONS', status: 'claimed' as const, workerId: 'w',
};

async function post(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const app = Fastify();
  await registerChatContinuationTaskRoutes(app);
  await app.ready();
  const res = await app.inject({
    method: 'POST', url: '/api/tasks/chat-continuation',
    headers: { authorization: 'Bearer tok', ...headers },
    payload: body,
  });
  await app.close();
  return { status: res.statusCode, body: res.json() as Record<string, unknown> };
}

beforeEach(() => {
  jest.clearAllMocks();
  process.env.WORKFORCE_SERVICE_URL = 'https://wf.test';
  process.env.WORKFORCE_SERVICE_ACCOUNT_EMAIL = 'wf@test.iam';
  scripted = [{ type: 'complete', message: { id: 'm-1', content: 'The rest.' } }];
  store.claim.mockResolvedValue(ROW);
  store.recheck.mockResolvedValue(ROW);
  store.running.mockResolvedValue(true);
  store.requeue.mockResolvedValue(true);
  store.finish.mockResolvedValue(undefined);
  store.newer.mockResolvedValue(false);
  mockFindLiveTurnId.mockResolvedValue(null);
  mockProfiles.mockResolvedValue(new Map([[ROW.accountId, { accountId: ROW.accountId, firstName: 'Ada', lastName: 'L', email: 'ada@example.com', avatarUrl: null, role: 'member' }]]));
});

const BODY = { continuationId: ROW.id, tenantId: TENANT };

describe('the Chief AI Officer continuation task', () => {
  it('claim → free thread → recheck → running → run as the person with their live role, no user message, the continuation and the deadline; done', async () => {
    const res = await post(BODY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'done' });
    const order = [store.claim, mockFindLiveTurnId, store.recheck, store.newer, store.running, mockRunTurn, store.finish].map((m) => m.mock.invocationCallOrder[0]);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    const input = mockRunTurn.mock.calls[0][0] as Record<string, unknown>;
    expect(input).toMatchObject({
      tenantId: TENANT, threadId: ROW.threadId, accountId: ROW.accountId, role: 'member', userMessage: '', callerName: 'Ada L',
      continuation: { originMessageId: ROW.originMessageId, ordinal: 1 },
    });
    expect(typeof input.replyDeadlineAt).toBe('number');
    expect(store.finish).toHaveBeenCalledWith(TENANT, ROW.id, expect.any(String), 'done', 'completed');
  });

  it('cancel before claim: nothing runs', async () => {
    store.claim.mockResolvedValue(null);
    expect((await post(BODY)).body).toEqual({ noop: true });
    expect(mockRunTurn).not.toHaveBeenCalled();
  });

  it('cancel between claim and the thread check: the recheck finds the row gone', async () => {
    store.recheck.mockResolvedValue(null);
    expect((await post(BODY)).body).toEqual({ noop: true, reason: 'not_claimed' });
    expect(mockRunTurn).not.toHaveBeenCalled();
  });

  it('a newer person message: cancelled as superseded', async () => {
    store.newer.mockResolvedValue(true);
    expect((await post(BODY)).body).toEqual({ status: 'cancelled', reason: 'superseded' });
    expect(store.finish).toHaveBeenCalledWith(TENANT, ROW.id, expect.any(String), 'cancelled', 'superseded');
    expect(mockRunTurn).not.toHaveBeenCalled();
  });

  it('a live turn on the thread: re-queued and retried, and failed (lock_busy) on the last delivery', async () => {
    mockFindLiveTurnId.mockResolvedValue('turn-live');
    const retry = await post(BODY, { 'x-cloudtasks-taskretrycount': '2' });
    expect(retry.status).toBe(503);
    expect(store.requeue).toHaveBeenCalledWith(TENANT, ROW.id, expect.any(String));
    const last = await post(BODY, { 'x-cloudtasks-taskretrycount': String(CONTINUATION_QUEUE_MAX_ATTEMPTS - 1) });
    expect(last.status).toBe(200);
    expect(last.body).toEqual({ status: 'failed', reason: 'lock_busy' });
    expect(store.finish).toHaveBeenCalledWith(TENANT, ROW.id, expect.any(String), 'failed', 'lock_busy');
  });

  it('a person the control plane cannot resolve fails the row rather than running as nobody', async () => {
    mockProfiles.mockResolvedValue(new Map());
    expect((await post(BODY)).body).toEqual({ status: 'failed', reason: 'caller_unresolved' });
    expect(mockRunTurn).not.toHaveBeenCalled();
  });
});
