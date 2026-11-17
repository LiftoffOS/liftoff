/**
 * browser-sessions REST router — verifies auth + thread ownership + proxy
 * call propagation for every route. The Connect-RPC client is mocked so we
 * assert "did the right RPC get called with the right args".
 */
import type { Request, Response } from 'express';

const resolveCallerMock = jest.fn();
const getThreadMock = jest.fn();

jest.mock('../../auth/resolve-caller', () => ({
  resolveCaller: (...args: unknown[]) => resolveCallerMock(...args),
}));

jest.mock('../../agent-chat/chat-repository', () => ({
  getThread: (...args: unknown[]) => getThreadMock(...args),
}));
// The other three surfaces, for the presence tests that name one. Each is
// found on its own table (or, for the CAIO, across the service boundary).
const getLiftoffThreadMock = jest.fn();
const teamPlanThreadExistsMock = jest.fn();
jest.mock('../../liftoff/chat-repository', () => ({
  getThread: (...args: unknown[]) => getLiftoffThreadMock(...args),
}));
jest.mock('../../insights/chat-repository', () => ({
  getThread: jest.fn(),
}));
jest.mock('../../workforce-plans/team-plan-thread-client', () => ({
  teamPlanThreadExists: (...args: unknown[]) => teamPlanThreadExistsMock(...args),
}));

// The pane shows whose browser this is, so the router resolves owner_account_id
// against the control-plane accounts table. Mocked to keep the router unit-level.
const getAccountByIdMock = jest.fn().mockResolvedValue(null);
const getDriverMock = jest.fn().mockResolvedValue(null);
const claimDriverMock = jest.fn().mockResolvedValue(undefined);
const releaseDriverMock = jest.fn().mockResolvedValue(undefined);
jest.mock('../driver-repository', () => ({
  getDriver: (...a: unknown[]) => getDriverMock(...a),
  claimDriver: (...a: unknown[]) => claimDriverMock(...a),
  releaseDriver: (...a: unknown[]) => releaseDriverMock(...a),
}));

jest.mock('../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getById: (...args: unknown[]) => getAccountByIdMock(...args),
  })),
}));

const rpcMock = {
  listSessionsForThread: jest.fn(),
  getActiveSessionForThread: jest.fn(),
  createSessionForThread: jest.fn(),
  pauseSession: jest.fn(),
  resumeSession: jest.fn(),
  ensureSessionForThread: jest.fn(),
  endSession: jest.fn(),
  goto: jest.fn(),
  getPageState: jest.fn(),
  setViewport: jest.fn(),
  pointAt: jest.fn(),
};
jest.mock('../../connectors/tenant-runtime-service-client', () => ({
  getBrowserSessionsServiceClient: jest.fn().mockResolvedValue(rpcMock),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { browserSessionsRouter } from '../router';
import { create } from '@bufbuild/protobuf';
import { timestampFromDate } from '@bufbuild/protobuf/wkt';
import {
  BrowserSessionSchema,
  PendingInterventionSchema,
  TakeoverActionSchema,
  TakeoverAction_ValueDisposition,
} from '@liftoffos/proto-gen/dist/liftoff/platform/v1/browser_sessions_pb.js';

const TENANT = '11111111-1111-1111-1111-111111111111';
const THREAD = '22222222-2222-2222-2222-222222222222';
const SESSION = '33333333-3333-3333-3333-333333333333';
const AGENT = '44444444-4444-4444-4444-444444444444';

// The real Connect client returns protobuf-es MESSAGE objects (not plain
// objects); the router serializes them with toJson(). Mocks must do the same or
// toJson() throws. A message with only `id` set serializes to `{ id }`.
const sessionMsg = (id: string) => create(BrowserSessionSchema, { id });

function findHandler(method: 'get' | 'post', path: string) {
  const layer = (browserSessionsRouter.stack as Array<{
    route?: { path: string; methods: Record<string, boolean>; stack: Array<{ handle: unknown }> };
  }>).find((l) => l.route?.path === path && l.route?.methods?.[method]);
  expect(layer).toBeDefined();
  const route = layer!.route!;
  return route.stack[route.stack.length - 1].handle as (
    req: Request, res: Response, next: () => void,
  ) => Promise<void>;
}

function mockRes(): Partial<Response> & {
  json: jest.Mock; status: jest.Mock; end: jest.Mock;
} {
  const res: Partial<Response> & {
    json: jest.Mock; status: jest.Mock; end: jest.Mock;
  } = {
    json: jest.fn(),
    status: jest.fn(),
    end: jest.fn(),
  };
  res.status.mockReturnValue(res);
  res.json.mockReturnValue(res);
  res.end.mockReturnValue(res);
  return res;
}

beforeEach(() => {
  jest.clearAllMocks();
  resolveCallerMock.mockResolvedValue({
    ok: true,
    caller: { accountId: 'acc-1', tenantId: TENANT, role: 'admin' },
  });
  getThreadMock.mockResolvedValue({ id: THREAD });
  getLiftoffThreadMock.mockResolvedValue({ id: THREAD });
  teamPlanThreadExistsMock.mockResolvedValue(true);
});

describe('GET /threads/:threadId/browser-sessions', () => {
  it('returns 400 on malformed threadId', async () => {
    const handler = findHandler('get', '/threads/:threadId/browser-sessions');
    const res = mockRes();
    await handler({
      params: { threadId: 'not-a-uuid' },
      query: { tenantId: TENANT },
    } as never, res as Response, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns the auth-resolution status code on auth failure', async () => {
    resolveCallerMock.mockResolvedValueOnce({ ok: false, status: 401, error: 'auth' });
    const handler = findHandler('get', '/threads/:threadId/browser-sessions');
    const res = mockRes();
    await handler({
      params: { threadId: THREAD },
      query: { tenantId: TENANT },
    } as never, res as Response, jest.fn());
    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('returns 404 when caller is not a member of the thread', async () => {
    getThreadMock.mockResolvedValueOnce(null);
    const handler = findHandler('get', '/threads/:threadId/browser-sessions');
    const res = mockRes();
    await handler({
      params: { threadId: THREAD },
      query: { tenantId: TENANT },
    } as never, res as Response, jest.fn());
    expect(res.status).toHaveBeenCalledWith(404);
  });

  it('forwards the listSessionsForThread RPC and returns sessions', async () => {
    rpcMock.listSessionsForThread.mockResolvedValueOnce({ sessions: [sessionMsg(SESSION)] });
    const handler = findHandler('get', '/threads/:threadId/browser-sessions');
    const res = mockRes();
    await handler({
      params: { threadId: THREAD },
      query: { tenantId: TENANT, includeClosed: 'true' },
    } as never, res as Response, jest.fn());
    expect(rpcMock.listSessionsForThread).toHaveBeenCalledWith({
      tenantContext: { tenantId: TENANT },
      threadId: THREAD,
      includeClosed: true,
    });
    expect(res.json).toHaveBeenCalledWith({ sessions: [{ id: SESSION, owner: null, driver: null, intervention: null }] });
  });
});

describe('GET /threads/:threadId/browser-sessions/active', () => {
  // New contract: RPC always returns success. Response carries both `session`
  // (active) and `lastClosedSession` (most-recent closed) as optional fields;
  // the 404 branch is gone, replaced by `session: null`.
  it('returns 200 with both fields null when no sessions exist', async () => {
    rpcMock.getActiveSessionForThread.mockResolvedValueOnce({});
    const handler = findHandler('get', '/threads/:threadId/browser-sessions/active');
    const res = mockRes();
    await handler({
      params: { threadId: THREAD }, query: { tenantId: TENANT },
    } as never, res as Response, jest.fn());
    expect(res.status).not.toHaveBeenCalledWith(404);
    expect(res.json).toHaveBeenCalledWith({ session: null, lastClosedSession: null });
  });

  // The pane renders an avatar for whoever is driving the browser, so the
  // owner account has to arrive resolved rather than as a bare id.
  it('resolves owner_account_id into the person on the session payload', async () => {
    getAccountByIdMock.mockResolvedValueOnce({
      id: 'acc-1', firstName: 'Ada', lastName: 'Lovelace',
      email: 'ada@example.com', avatarUrl: 'https://cdn/ada.png',
    });
    rpcMock.getActiveSessionForThread.mockResolvedValueOnce({
      session: create(BrowserSessionSchema, { id: SESSION, ownerAccountId: 'acc-1' }),
    });
    const handler = findHandler('get', '/threads/:threadId/browser-sessions/active');
    const res = mockRes();
    await handler({
      params: { threadId: THREAD }, query: { tenantId: TENANT },
    } as never, res as Response, jest.fn());

    expect(getAccountByIdMock).toHaveBeenCalledWith('acc-1');
    expect(res.json).toHaveBeenCalledWith({
      session: {
        id: SESSION,
        ownerAccountId: 'acc-1',
        owner: {
          accountId: 'acc-1', firstName: 'Ada', lastName: 'Lovelace',
          email: 'ada@example.com', avatarUrl: 'https://cdn/ada.png',
        },
        driver: null,
        intervention: null,
      },
      lastClosedSession: null,
    });
  });

  it('looks the owner up once when both sessions share it', async () => {
    getAccountByIdMock.mockResolvedValue({
      id: 'acc-1', firstName: 'Ada', lastName: 'Lovelace',
      email: 'ada@example.com', avatarUrl: null,
    });
    rpcMock.getActiveSessionForThread.mockResolvedValueOnce({
      session: create(BrowserSessionSchema, { id: SESSION, ownerAccountId: 'acc-1' }),
      lastClosedSession: create(BrowserSessionSchema, { id: SESSION, ownerAccountId: 'acc-1' }),
    });
    const handler = findHandler('get', '/threads/:threadId/browser-sessions/active');
    await handler({
      params: { threadId: THREAD }, query: { tenantId: TENANT },
    } as never, mockRes() as Response, jest.fn());

    expect(getAccountByIdMock).toHaveBeenCalledTimes(1);
  });

  // A missing or unreadable account must never break the session read; the
  // pane just renders without an avatar.
  it('returns owner: null when the account cannot be resolved', async () => {
    getAccountByIdMock.mockRejectedValueOnce(new Error('connection refused'));
    rpcMock.getActiveSessionForThread.mockResolvedValueOnce({
      session: create(BrowserSessionSchema, { id: SESSION, ownerAccountId: 'acc-gone' }),
    });
    const handler = findHandler('get', '/threads/:threadId/browser-sessions/active');
    const res = mockRes();
    await handler({
      params: { threadId: THREAD }, query: { tenantId: TENANT },
    } as never, res as Response, jest.fn());

    expect(res.status).not.toHaveBeenCalledWith(500);
    expect(res.json).toHaveBeenCalledWith({
      session: { id: SESSION, ownerAccountId: 'acc-gone', owner: null, driver: null, intervention: null },
      lastClosedSession: null,
    });
  });

  // Observers need to know whose session they are watching, and control has to
  // be handed back to a named person, so takeover has to carry an identity.
  it('names the driver when a human holds control', async () => {
    getDriverMock.mockResolvedValueOnce({
      accountId: 'acc-9', firstName: 'Grace', lastName: 'Hopper',
      email: 'grace@example.com', avatarUrl: null,
      takenAt: '2026-07-28T00:00:00.000Z', present: true,
    });
    rpcMock.getActiveSessionForThread.mockResolvedValueOnce({
      session: create(BrowserSessionSchema, { id: SESSION, takeoverState: 'taken_over' }),
    });
    const handler = findHandler('get', '/threads/:threadId/browser-sessions/active');
    const res = mockRes();
    await handler({
      params: { threadId: THREAD }, query: { tenantId: TENANT },
    } as never, res as Response, jest.fn());

    // Presence is read on THIS surface, by the caller making the read: the
    // default surface is the agent chat, and the caller is acc-1.
    expect(getDriverMock).toHaveBeenCalledWith(TENANT, SESSION, { surface: 'agent', callerAccountId: 'acc-1', threadId: THREAD });
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.session.driver.email).toBe('grace@example.com');
    expect(body.session.driver.present).toBe(true);
  });

  it('reads the driver\'s presence on the surface the thread is on', async () => {
    getDriverMock.mockResolvedValueOnce({
      accountId: 'acc-9', firstName: 'Grace', lastName: 'Hopper',
      email: 'grace@example.com', avatarUrl: null,
      takenAt: '2026-07-28T00:00:00.000Z', present: true,
    });
    rpcMock.getActiveSessionForThread.mockResolvedValueOnce({
      session: create(BrowserSessionSchema, { id: SESSION, takeoverState: 'taken_over' }),
    });
    const handler = findHandler('get', '/threads/:threadId/browser-sessions/active');
    await handler({
      params: { threadId: THREAD }, query: { tenantId: TENANT, surface: 'liftoff' },
    } as never, mockRes() as Response, jest.fn());
    expect(getDriverMock).toHaveBeenCalledWith(TENANT, SESSION, { surface: 'liftoff', callerAccountId: 'acc-1', threadId: THREAD });
  });

  // The driver's own poll is the heartbeat that keeps the runtime's hold
  // fresh; anyone else watching the pane restamps nothing.
  it('refreshes the hold when the present driver is the one polling', async () => {
    getDriverMock.mockResolvedValueOnce({
      accountId: 'acc-1', firstName: 'Ada', lastName: 'Lovelace',
      email: 'ada@example.com', avatarUrl: null,
      takenAt: '2026-07-28T00:00:00.000Z', present: true,
    });
    rpcMock.getActiveSessionForThread.mockResolvedValueOnce({
      session: create(BrowserSessionSchema, { id: SESSION, takeoverState: 'taken_over' }),
    });
    rpcMock.pauseSession.mockResolvedValueOnce({});
    const handler = findHandler('get', '/threads/:threadId/browser-sessions/active');
    await handler({
      params: { threadId: THREAD }, query: { tenantId: TENANT, surface: 'liftoff' },
    } as never, mockRes() as Response, jest.fn());
    expect(rpcMock.pauseSession).toHaveBeenCalledWith({ tenantContext: { tenantId: TENANT }, sessionId: SESSION });
    expect(rpcMock.resumeSession).not.toHaveBeenCalled();
    expect(releaseDriverMock).not.toHaveBeenCalled();
  });

  it('does not refresh the hold for a watcher who is not the driver', async () => {
    getDriverMock.mockResolvedValueOnce({
      accountId: 'acc-9', firstName: 'Grace', lastName: 'Hopper',
      email: 'grace@example.com', avatarUrl: null,
      takenAt: '2026-07-28T00:00:00.000Z', present: true,
    });
    rpcMock.getActiveSessionForThread.mockResolvedValueOnce({
      session: create(BrowserSessionSchema, { id: SESSION, takeoverState: 'taken_over' }),
    });
    const handler = findHandler('get', '/threads/:threadId/browser-sessions/active');
    await handler({
      params: { threadId: THREAD }, query: { tenantId: TENANT },
    } as never, mockRes() as Response, jest.fn());
    expect(rpcMock.pauseSession).not.toHaveBeenCalled();
  });

  // The Chief AI Officer surface asks workforce-service about the driver, so
  // a colleague's poll sweeps an absent driver there exactly as on the other
  // three surfaces.
  it("a colleague's poll on the Chief AI Officer surface sweeps an absent driver with absent_driver", async () => {
    getDriverMock.mockResolvedValueOnce({
      accountId: 'acc-9', firstName: 'Grace', lastName: 'Hopper',
      email: 'grace@example.com', avatarUrl: null,
      takenAt: '2026-07-28T00:00:00.000Z', present: false,
    });
    rpcMock.getActiveSessionForThread.mockResolvedValueOnce({
      session: create(BrowserSessionSchema, { id: SESSION, takeoverState: 'taken_over' }),
    });
    rpcMock.resumeSession.mockResolvedValueOnce({});
    const handler = findHandler('get', '/threads/:threadId/browser-sessions/active');
    const res = mockRes();
    await handler({
      params: { threadId: THREAD }, query: { tenantId: TENANT, surface: 'team_plan' },
    } as never, res as Response, jest.fn());
    expect(getDriverMock).toHaveBeenCalledWith(TENANT, SESSION, { surface: 'team_plan', callerAccountId: 'acc-1', threadId: THREAD });
    expect(rpcMock.resumeSession).toHaveBeenCalledWith({
      tenantContext: { tenantId: TENANT }, sessionId: SESSION, endReason: 'absent_driver',
    });
    expect(releaseDriverMock).toHaveBeenCalledWith(TENANT, SESSION);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.session.takeoverState).toBe('none');
  });

  // Unknown is not absent. A surface whose presence source could not answer
  // yields null, and null must never take control away.
  it('leaves control alone when presence is unknown', async () => {
    getDriverMock.mockResolvedValueOnce({
      accountId: 'acc-9', firstName: 'Grace', lastName: 'Hopper',
      email: 'grace@example.com', avatarUrl: null,
      takenAt: '2026-07-28T00:00:00.000Z', present: null,
    });
    rpcMock.getActiveSessionForThread.mockResolvedValueOnce({
      session: create(BrowserSessionSchema, { id: SESSION, takeoverState: 'taken_over' }),
    });
    const handler = findHandler('get', '/threads/:threadId/browser-sessions/active');
    await handler({
      params: { threadId: THREAD }, query: { tenantId: TENANT, surface: 'team_plan' },
    } as never, mockRes() as Response, jest.fn());
    expect(rpcMock.resumeSession).not.toHaveBeenCalled();
    expect(rpcMock.pauseSession).not.toHaveBeenCalled();
    expect(releaseDriverMock).not.toHaveBeenCalled();
  });

  // takeover_state is the authority on whether anyone holds control. A driver
  // row without it is stale bookkeeping from a release that raced a read.
  it('does not name a driver when nobody has taken control', async () => {
    rpcMock.getActiveSessionForThread.mockResolvedValueOnce({
      session: create(BrowserSessionSchema, { id: SESSION }),
    });
    const handler = findHandler('get', '/threads/:threadId/browser-sessions/active');
    const res = mockRes();
    await handler({
      params: { threadId: THREAD }, query: { tenantId: TENANT },
    } as never, res as Response, jest.fn());

    expect(getDriverMock).not.toHaveBeenCalled();
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.session.driver).toBeNull();
  });

  // A driver who closed their tab cannot tell us they let go. Without this the
  // agent stays blocked at tool dispatch forever.
  it('releases control from a driver whose presence has gone stale', async () => {
    getDriverMock.mockResolvedValueOnce({
      accountId: 'acc-9', firstName: 'Grace', lastName: 'Hopper',
      email: 'grace@example.com', avatarUrl: null,
      takenAt: '2026-07-28T00:00:00.000Z', present: false,
    });
    rpcMock.getActiveSessionForThread.mockResolvedValueOnce({
      session: create(BrowserSessionSchema, { id: SESSION, takeoverState: 'taken_over' }),
    });
    rpcMock.resumeSession.mockResolvedValueOnce({});
    const handler = findHandler('get', '/threads/:threadId/browser-sessions/active');
    const res = mockRes();
    await handler({
      params: { threadId: THREAD }, query: { tenantId: TENANT },
    } as never, res as Response, jest.fn());

    // Clearing our row is not enough — takeover_state lives in tenant-runtime.
    // The reason is named, so the runtime's record of the hold says the
    // driver went away rather than that they gave control back.
    expect(rpcMock.resumeSession).toHaveBeenCalledWith({
      tenantContext: { tenantId: TENANT }, sessionId: SESSION, endReason: 'absent_driver',
    });
    expect(releaseDriverMock).toHaveBeenCalledWith(TENANT, SESSION);
    const body = (res.json as jest.Mock).mock.calls[0][0];
    expect(body.session.takeoverState).toBe('none');
  });

  it('leaves control alone while the driver is still present', async () => {
    getDriverMock.mockResolvedValue({
      accountId: 'acc-9', firstName: 'Grace', lastName: 'Hopper',
      email: 'grace@example.com', avatarUrl: null,
      takenAt: '2026-07-28T00:00:00.000Z', present: true,
    });
    rpcMock.getActiveSessionForThread.mockResolvedValueOnce({
      session: create(BrowserSessionSchema, { id: SESSION, takeoverState: 'taken_over' }),
    });
    const handler = findHandler('get', '/threads/:threadId/browser-sessions/active');
    await handler({
      params: { threadId: THREAD }, query: { tenantId: TENANT },
    } as never, mockRes() as Response, jest.fn());

    expect(rpcMock.resumeSession).not.toHaveBeenCalled();
    expect(releaseDriverMock).not.toHaveBeenCalled();
  });

  // A failed self-heal must never take the read down with it.
  it('still serves the session when the stale release fails', async () => {
    getDriverMock.mockResolvedValueOnce({
      accountId: 'acc-9', firstName: 'Grace', lastName: 'Hopper',
      email: 'grace@example.com', avatarUrl: null,
      takenAt: '2026-07-28T00:00:00.000Z', present: false,
    });
    rpcMock.getActiveSessionForThread.mockResolvedValueOnce({
      session: create(BrowserSessionSchema, { id: SESSION, takeoverState: 'taken_over' }),
    });
    rpcMock.resumeSession.mockRejectedValueOnce(new Error('runtime down'));
    const handler = findHandler('get', '/threads/:threadId/browser-sessions/active');
    const res = mockRes();
    await handler({
      params: { threadId: THREAD }, query: { tenantId: TENANT },
    } as never, res as Response, jest.fn());

    expect(res.status).not.toHaveBeenCalledWith(500);
    expect((res.json as jest.Mock).mock.calls[0][0].session.id).toBe(SESSION);
  });

  it('returns 200 with lastClosedSession when an idle-timed-out session exists and no active one', async () => {
    rpcMock.getActiveSessionForThread.mockResolvedValueOnce({
      lastClosedSession: sessionMsg(SESSION),
    });
    const handler = findHandler('get', '/threads/:threadId/browser-sessions/active');
    const res = mockRes();
    await handler({
      params: { threadId: THREAD }, query: { tenantId: TENANT },
    } as never, res as Response, jest.fn());
    expect(res.json).toHaveBeenCalledWith({
      session: null,
      lastClosedSession: { id: SESSION, owner: null, driver: null, intervention: null },
    });
  });

  it('returns 200 with active session when one is live', async () => {
    rpcMock.getActiveSessionForThread.mockResolvedValueOnce({
      session: sessionMsg(SESSION),
    });
    const handler = findHandler('get', '/threads/:threadId/browser-sessions/active');
    const res = mockRes();
    await handler({
      params: { threadId: THREAD }, query: { tenantId: TENANT },
    } as never, res as Response, jest.fn());
    expect(res.json).toHaveBeenCalledWith({
      session: { id: SESSION, owner: null, driver: null, intervention: null },
      lastClosedSession: null,
    });
  });

  it('returns 500 on unexpected RPC error', async () => {
    rpcMock.getActiveSessionForThread.mockRejectedValueOnce(new Error('boom'));
    const handler = findHandler('get', '/threads/:threadId/browser-sessions/active');
    const res = mockRes();
    await handler({
      params: { threadId: THREAD }, query: { tenantId: TENANT },
    } as never, res as Response, jest.fn());
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

describe('POST /threads/:threadId/browser-sessions', () => {
  it('rejects when body.agentId is missing', async () => {
    const handler = findHandler('post', '/threads/:threadId/browser-sessions');
    const res = mockRes();
    await handler({
      params: { threadId: THREAD },
      query: { tenantId: TENANT },
      body: {},
    } as never, res as Response, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('returns 201 + session on success', async () => {
    rpcMock.createSessionForThread.mockResolvedValueOnce({ session: sessionMsg(SESSION) });
    const handler = findHandler('post', '/threads/:threadId/browser-sessions');
    const res = mockRes();
    await handler({
      params: { threadId: THREAD },
      query: { tenantId: TENANT },
      body: { agentId: AGENT },
    } as never, res as Response, jest.fn());
    expect(rpcMock.createSessionForThread).toHaveBeenCalledWith({
      tenantContext: { tenantId: TENANT },
      threadId: THREAD,
      agentId: AGENT,
    });
    expect(res.status).toHaveBeenCalledWith(201);
  });
});

describe('POST /browser-sessions/:sessionId/pause + /resume', () => {
  const HOLD = '55555555-5555-4555-8555-555555555555';
  const driver = (accountId: string, present: boolean | null) => ({
    accountId, firstName: 'Ada', lastName: 'Lovelace', email: 'ada@example.com', avatarUrl: null, takenAt: '2026-09-01T10:00:00.000Z', present,
  });

  it('pauseSession forwards tenant + sessionId to the RPC', async () => {
    rpcMock.pauseSession.mockResolvedValueOnce({ session: sessionMsg(SESSION) });
    const handler = findHandler('post', '/browser-sessions/:sessionId/pause');
    const res = mockRes();
    await handler({
      params: { sessionId: SESSION },
      query: { tenantId: TENANT },
    } as never, res as Response, jest.fn());
    expect(rpcMock.pauseSession).toHaveBeenCalledWith({
      tenantContext: { tenantId: TENANT },
      sessionId: SESSION,
    });
    expect(claimDriverMock).toHaveBeenCalledWith(TENANT, SESSION, 'acc-1');
  });

  it('pause answers held_by_other for a present other driver while the runtime holds the session taken over, and claims nothing', async () => {
    getDriverMock.mockResolvedValueOnce(driver('acc-2', true));
    rpcMock.getActiveSessionForThread.mockResolvedValueOnce({
      session: create(BrowserSessionSchema, { id: SESSION, takeoverState: 'taken_over' }),
    });
    const handler = findHandler('post', '/browser-sessions/:sessionId/pause');
    const res = mockRes();
    await handler({
      params: { sessionId: SESSION },
      query: { tenantId: TENANT, threadId: THREAD },
    } as never, res as Response, jest.fn());
    // Presence is read on the surface the client named (agent chat by default).
    expect(getDriverMock).toHaveBeenCalledWith(TENANT, SESSION, { surface: 'agent', callerAccountId: 'acc-1', threadId: THREAD });
    expect(res.status).toHaveBeenCalledWith(409);
    expect(res.json).toHaveBeenCalledWith({ error: 'held_by_other' });
    expect(rpcMock.pauseSession).not.toHaveBeenCalled();
    expect(claimDriverMock).not.toHaveBeenCalled();
  });

  it('pause claims when the other driver is known absent, when the runtime no longer holds the session, and for the driver themselves', async () => {
    const handler = findHandler('post', '/browser-sessions/:sessionId/pause');
    rpcMock.pauseSession.mockResolvedValue({ session: sessionMsg(SESSION) });
    // The sweep released an absent driver: presence false, no runtime read.
    getDriverMock.mockResolvedValueOnce(driver('acc-2', false));
    let res = mockRes();
    await handler({ params: { sessionId: SESSION }, query: { tenantId: TENANT, threadId: THREAD } } as never, res as Response, jest.fn());
    expect(rpcMock.getActiveSessionForThread).not.toHaveBeenCalled();
    expect(claimDriverMock).toHaveBeenCalledTimes(1);
    // A stale driver record: the runtime's hold has ended.
    getDriverMock.mockResolvedValueOnce(driver('acc-2', null));
    rpcMock.getActiveSessionForThread.mockResolvedValueOnce({ session: create(BrowserSessionSchema, { id: SESSION, takeoverState: 'none' }) });
    res = mockRes();
    await handler({ params: { sessionId: SESSION }, query: { tenantId: TENANT, threadId: THREAD } } as never, res as Response, jest.fn());
    expect(claimDriverMock).toHaveBeenCalledTimes(2);
    // The recorded driver refreshing their own hold.
    getDriverMock.mockResolvedValueOnce(driver('acc-1', true));
    res = mockRes();
    await handler({ params: { sessionId: SESSION }, query: { tenantId: TENANT, threadId: THREAD } } as never, res as Response, jest.fn());
    expect(claimDriverMock).toHaveBeenCalledTimes(3);
    expect(rpcMock.getActiveSessionForThread).toHaveBeenCalledTimes(1);
  });

  it('pause with a thread the caller cannot see is 404 before any RPC', async () => {
    getDriverMock.mockResolvedValueOnce(driver('acc-2', null));
    getThreadMock.mockResolvedValueOnce(null);
    const handler = findHandler('post', '/browser-sessions/:sessionId/pause');
    const res = mockRes();
    await handler({ params: { sessionId: SESSION }, query: { tenantId: TENANT, threadId: THREAD } } as never, res as Response, jest.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(rpcMock.pauseSession).not.toHaveBeenCalled();
  });

  it('resumeSession forwards tenant + sessionId to the RPC, with no reason: the person released it, and reports the hold and who released it', async () => {
    getDriverMock.mockResolvedValueOnce(driver('acc-1', true));
    rpcMock.resumeSession.mockResolvedValueOnce({ session: sessionMsg(SESSION), holdId: HOLD });
    const handler = findHandler('post', '/browser-sessions/:sessionId/resume');
    const res = mockRes();
    await handler({
      params: { sessionId: SESSION },
      query: { tenantId: TENANT },
    } as never, res as Response, jest.fn());
    // No end_reason: the runtime reads empty as `released`, which is what a
    // person clicking release control means.
    expect(rpcMock.resumeSession).toHaveBeenCalledWith({
      tenantContext: { tenantId: TENANT },
      sessionId: SESSION,
    });
    // The driver is read BEFORE the release deletes the record.
    expect(getDriverMock.mock.invocationCallOrder[0]).toBeLessThan(rpcMock.resumeSession.mock.invocationCallOrder[0]);
    expect(releaseDriverMock).toHaveBeenCalledWith(TENANT, SESSION);
    expect(res.json).toHaveBeenCalledWith({
      session: { id: SESSION, owner: null, driver: null, intervention: null },
      holdId: HOLD,
      releasedByDriver: true,
    });
  });

  it('resume by another member releases the wheel but is not the driver\'s hand-back; no hold means no hand-back either', async () => {
    const handler = findHandler('post', '/browser-sessions/:sessionId/resume');
    getDriverMock.mockResolvedValueOnce(driver('acc-2', true));
    rpcMock.resumeSession.mockResolvedValueOnce({ session: sessionMsg(SESSION), holdId: HOLD });
    let res = mockRes();
    await handler({ params: { sessionId: SESSION }, query: { tenantId: TENANT } } as never, res as Response, jest.fn());
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ holdId: HOLD, releasedByDriver: false }));
    getDriverMock.mockResolvedValueOnce(driver('acc-1', true));
    rpcMock.resumeSession.mockResolvedValueOnce({ session: sessionMsg(SESSION), holdId: '' });
    res = mockRes();
    await handler({ params: { sessionId: SESSION }, query: { tenantId: TENANT } } as never, res as Response, jest.fn());
    expect(res.json).toHaveBeenCalledWith(expect.objectContaining({ holdId: null, releasedByDriver: false }));
  });
});

describe('the session JSON carries that a request for the person is open, never why', () => {
  it('exposes intervention as { requestedAt } and drops the reason', async () => {
    rpcMock.listSessionsForThread.mockResolvedValueOnce({
      sessions: [create(BrowserSessionSchema, {
        id: SESSION,
        intervention: create(PendingInterventionSchema, { id: 'i1', reason: 'sign in to the portal', requestedAt: timestampFromDate(new Date('2026-09-01T10:00:00Z')) }),
      })],
    });
    const handler = findHandler('get', '/threads/:threadId/browser-sessions');
    const res = mockRes();
    await handler({ params: { threadId: THREAD }, query: { tenantId: TENANT } } as never, res as Response, jest.fn());
    const body = res.json.mock.calls[0][0] as { sessions: Array<{ intervention: unknown }> };
    expect(body.sessions[0].intervention).toEqual({ requestedAt: '2026-09-01T10:00:00Z' });
    expect(JSON.stringify(body)).not.toContain('sign in to the portal');
  });
});

describe('POST /threads/:threadId/browser-sessions/:sessionId/viewport', () => {
  const handler = () => findHandler('post', '/threads/:threadId/browser-sessions/:sessionId/viewport');

  it('applies an even size within bounds through SetViewport, on the authorized thread', async () => {
    rpcMock.setViewport.mockResolvedValueOnce({ applied: { width: 1280, height: 800 } });
    const res = mockRes();
    await handler()({
      params: { threadId: THREAD, sessionId: SESSION }, query: { tenantId: TENANT }, body: { viewport: { width: 1280, height: 800 } },
    } as never, res as Response, jest.fn());
    expect(rpcMock.setViewport).toHaveBeenCalledWith({
      tenantContext: { tenantId: TENANT }, sessionId: SESSION, threadId: THREAD, viewport: { width: 1280, height: 800 },
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({ applied: { width: 1280, height: 800 } });
  });

  it('refuses a size outside [640, 1920] x [480, 1200], an odd one, and a non-integer, before any RPC', async () => {
    for (const viewport of [{ width: 638, height: 800 }, { width: 1922, height: 800 }, { width: 1280, height: 478 }, { width: 1280, height: 1202 }, { width: 1281, height: 800 }, { width: 1280.5, height: 800 }]) {
      const res = mockRes();
      await handler()({ params: { threadId: THREAD, sessionId: SESSION }, query: { tenantId: TENANT }, body: { viewport } } as never, res as Response, jest.fn());
      expect(res.status).toHaveBeenCalledWith(400);
    }
    expect(rpcMock.setViewport).not.toHaveBeenCalled();
  });

  it('is thread-authorized: a thread the caller cannot see is 404', async () => {
    getThreadMock.mockResolvedValueOnce(null);
    const res = mockRes();
    await handler()({ params: { threadId: THREAD, sessionId: SESSION }, query: { tenantId: TENANT }, body: { viewport: { width: 1280, height: 800 } } } as never, res as Response, jest.fn());
    expect(res.status).toHaveBeenCalledWith(404);
    expect(rpcMock.setViewport).not.toHaveBeenCalled();
  });

  it('ensure passes the pane\'s size through, and refuses one out of bounds', async () => {
    rpcMock.ensureSessionForThread.mockResolvedValueOnce({ session: sessionMsg(SESSION), wasNewlyCreated: true });
    const ensure = findHandler('post', '/threads/:threadId/browser-sessions/ensure');
    let res = mockRes();
    await ensure({ params: { threadId: THREAD }, query: { tenantId: TENANT }, body: { agentId: AGENT, viewport: { width: 1000, height: 700 } } } as never, res as Response, jest.fn());
    expect(rpcMock.ensureSessionForThread).toHaveBeenCalledWith(expect.objectContaining({ viewport: { width: 1000, height: 700 } }));
    res = mockRes();
    await ensure({ params: { threadId: THREAD }, query: { tenantId: TENANT }, body: { agentId: AGENT, viewport: { width: 100, height: 700 } } } as never, res as Response, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(rpcMock.ensureSessionForThread).toHaveBeenCalledTimes(1);
  });
});

describe('POST /threads/:threadId/browser-sessions/:sessionId/point', () => {
  const HOLD = '66666666-6666-4666-8666-666666666666';
  const handler = () => findHandler('post', '/threads/:threadId/browser-sessions/:sessionId/point');
  const body = { x: 0.25, y: 0.5, overlayWidth: 1280, overlayHeight: 800 };



});

describe('POST /threads/:threadId/browser-sessions/ensure', () => {
  it('400s when agentId is missing/invalid', async () => {
    const handler = findHandler('post', '/threads/:threadId/browser-sessions/ensure');
    const res = mockRes();
    await handler({
      params: { threadId: THREAD }, query: { tenantId: TENANT }, body: {},
    } as never, res as Response, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
    expect(rpcMock.ensureSessionForThread).not.toHaveBeenCalled();
  });

  it('uses caller.accountId as owner and IGNORES any forged ownerAccountId in the body', async () => {
    rpcMock.ensureSessionForThread.mockResolvedValueOnce({
      session: sessionMsg(SESSION), wasNewlyCreated: true,
    });
    const handler = findHandler('post', '/threads/:threadId/browser-sessions/ensure');
    const res = mockRes();
    await handler({
      params: { threadId: THREAD },
      query: { tenantId: TENANT },
      // Attacker tries to set themselves (or someone else) as owner via the body.
      body: { agentId: AGENT, ownerAccountId: 'forged-account-id', callerAccountId: 'forged' },
    } as never, res as Response, jest.fn());
    expect(rpcMock.ensureSessionForThread).toHaveBeenCalledWith({
      tenantContext: { tenantId: TENANT },
      threadId: THREAD,
      agentId: AGENT,
      ownerAccountId: 'acc-1', // server-resolved caller, NOT the forged body value
    });
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      session: { id: SESSION, owner: null, driver: null, intervention: null }, wasNewlyCreated: true,
      error: null, lastClosedSession: null,
    });
  });

  // Typed error envelope: when the upstream RPC reports a classified failure
  // (Anchor outage, quota exhausted, key revoked), the router still returns
  // HTTP 200 — the response body carries the typed error so the frontend can
  // branch on `error.kind` and render distinct copy. lastClosedSession is
  // passed through so the paused-frame UX still works.
  it('returns 200 with typed error envelope when RPC returns a classified failure', async () => {
    const { EnsureSessionError_Kind, EnsureSessionErrorSchema } =
      await import('@liftoffos/proto-gen/dist/liftoff/platform/v1/browser_sessions_pb.js');
    rpcMock.ensureSessionForThread.mockResolvedValueOnce({
      error: create(EnsureSessionErrorSchema, {
        kind: EnsureSessionError_Kind.QUOTA_EXCEEDED,
        message: 'Anchor 402: out of credits',
      }),
      lastClosedSession: sessionMsg(SESSION),
    });
    const handler = findHandler('post', '/threads/:threadId/browser-sessions/ensure');
    const res = mockRes();
    await handler({
      params: { threadId: THREAD }, query: { tenantId: TENANT },
      body: { agentId: AGENT },
    } as never, res as Response, jest.fn());
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      session: null,
      wasNewlyCreated: false,
      error: { kind: 'quota_exceeded', message: 'Anchor 402: out of credits' },
      lastClosedSession: { id: SESSION, owner: null, driver: null, intervention: null },
    });
  });

  it('maps each EnsureSessionError kind to its stable string', async () => {
    const { EnsureSessionError_Kind, EnsureSessionErrorSchema } =
      await import('@liftoffos/proto-gen/dist/liftoff/platform/v1/browser_sessions_pb.js');
    const cases: Array<[number, string]> = [
      [EnsureSessionError_Kind.ANCHOR_UNAVAILABLE, 'anchor_unavailable'],
      [EnsureSessionError_Kind.QUOTA_EXCEEDED,     'quota_exceeded'],
      [EnsureSessionError_Kind.INVALID_KEY,        'invalid_key'],
      [EnsureSessionError_Kind.UNKNOWN,            'unknown'],
    ];
    const handler = findHandler('post', '/threads/:threadId/browser-sessions/ensure');
    for (const [kind, label] of cases) {
      rpcMock.ensureSessionForThread.mockResolvedValueOnce({
        error: create(EnsureSessionErrorSchema, { kind, message: 'x' }),
      });
      const res = mockRes();
      await handler({
        params: { threadId: THREAD }, query: { tenantId: TENANT },
        body: { agentId: AGENT },
      } as never, res as Response, jest.fn());
      expect(res.json).toHaveBeenCalledWith(
        expect.objectContaining({ error: { kind: label, message: 'x' } }),
      );
    }
  });
});

describe('POST /browser-sessions/:sessionId/end', () => {
  it('forwards callerAccountId from the resolved caller (not the body)', async () => {
    rpcMock.endSession.mockResolvedValueOnce({ session: sessionMsg(SESSION) });
    const handler = findHandler('post', '/browser-sessions/:sessionId/end');
    const res = mockRes();
    await handler({
      params: { sessionId: SESSION }, query: { tenantId: TENANT },
      body: { callerAccountId: 'forged' },
    } as never, res as Response, jest.fn());
    expect(rpcMock.endSession).toHaveBeenCalledWith({
      tenantContext: { tenantId: TENANT },
      sessionId: SESSION,
      callerAccountId: 'acc-1',
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it('maps PermissionDenied to 403 (non-owner cannot end)', async () => {
    rpcMock.endSession.mockRejectedValueOnce({ code: 'permission_denied' });
    const handler = findHandler('post', '/browser-sessions/:sessionId/end');
    const res = mockRes();
    await handler({
      params: { sessionId: SESSION }, query: { tenantId: TENANT }, body: {},
    } as never, res as Response, jest.fn());
    expect(res.status).toHaveBeenCalledWith(403);
  });

  it('maps NotFound to 404', async () => {
    rpcMock.endSession.mockRejectedValueOnce({ code: 5 });
    const handler = findHandler('post', '/browser-sessions/:sessionId/end');
    const res = mockRes();
    await handler({
      params: { sessionId: SESSION }, query: { tenantId: TENANT }, body: {},
    } as never, res as Response, jest.fn());
    expect(res.status).toHaveBeenCalledWith(404);
  });
});

describe('POST /browser-sessions/:sessionId/goto', () => {
  it('400s on a non-URL', async () => {
    const handler = findHandler('post', '/browser-sessions/:sessionId/goto');
    const res = mockRes();
    await handler({
      params: { sessionId: SESSION }, query: { tenantId: TENANT }, body: { url: 'not a url' },
    } as never, res as Response, jest.fn());
    expect(res.status).toHaveBeenCalledWith(400);
  });

  it('forwards the goto RPC with the url', async () => {
    rpcMock.goto.mockResolvedValueOnce({ session: sessionMsg(SESSION) });
    const handler = findHandler('post', '/browser-sessions/:sessionId/goto');
    const res = mockRes();
    await handler({
      params: { sessionId: SESSION }, query: { tenantId: TENANT },
      body: { url: 'https://example.com/page' },
    } as never, res as Response, jest.fn());
    expect(rpcMock.goto).toHaveBeenCalledWith({
      tenantContext: { tenantId: TENANT },
      sessionId: SESSION,
      url: 'https://example.com/page',
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

describe('GET /browser-sessions/:sessionId/page-state', () => {
  it('returns url + screenshot signed url', async () => {
    rpcMock.getPageState.mockResolvedValueOnce({
      url: 'https://example.com', screenshotSignedUrl: 'https://signed', signedUrlExpiresAt: null,
    });
    const handler = findHandler('get', '/browser-sessions/:sessionId/page-state');
    const res = mockRes();
    await handler({
      params: { sessionId: SESSION }, query: { tenantId: TENANT },
    } as never, res as Response, jest.fn());
    expect(rpcMock.getPageState).toHaveBeenCalledWith({
      tenantContext: { tenantId: TENANT },
      sessionId: SESSION,
    });
    expect(res.json).toHaveBeenCalledWith({
      url: 'https://example.com', screenshotSignedUrl: 'https://signed', signedUrlExpiresAt: null,
    });
  });
});
