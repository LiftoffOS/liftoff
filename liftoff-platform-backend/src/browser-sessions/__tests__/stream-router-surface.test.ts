/**
 * The SSE stream router resolves the thread on the surface the caller names,
 * with the same lookup the REST router uses.
 *
 * It had its own lookup, on agent chat alone, so every platform-assistant pane
 * (Liftoff, the Insights Manager, the Chief AI Officer) opened its event stream
 * and got a 404. The pane kept working off the query refetch backstop, and
 * nobody saw the session events the stream was built to carry.
 */
import type { Request, Response } from 'express';

const resolveCallerMock = jest.fn();
const getAgentThreadMock = jest.fn();
const getLiftoffThreadMock = jest.fn();
const getInsightsThreadMock = jest.fn();
const teamPlanThreadExistsMock = jest.fn();

jest.mock('../../auth/resolve-caller', () => ({
  resolveCaller: (...a: unknown[]) => resolveCallerMock(...a),
}));
jest.mock('../../agent-chat/chat-repository', () => ({
  getThread: (...a: unknown[]) => getAgentThreadMock(...a),
}));
jest.mock('../../liftoff/chat-repository', () => ({
  getThread: (...a: unknown[]) => getLiftoffThreadMock(...a),
}));
jest.mock('../../insights/chat-repository', () => ({
  getThread: (...a: unknown[]) => getInsightsThreadMock(...a),
}));
jest.mock('../../workforce-plans/team-plan-thread-client', () => ({
  teamPlanThreadExists: (...a: unknown[]) => teamPlanThreadExistsMock(...a),
}));

const streamSessionEventsMock = jest.fn();
jest.mock('../../connectors/tenant-runtime-service-client', () => ({
  getBrowserSessionsServiceClient: jest.fn().mockResolvedValue({
    streamSessionEvents: (...a: unknown[]) => streamSessionEventsMock(...a),
  }),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

import { browserSessionsStreamRouter } from '../stream-router';

const TENANT = '11111111-1111-1111-1111-111111111111';
const THREAD = '22222222-2222-2222-2222-222222222222';

function handler() {
  const layer = (browserSessionsStreamRouter.stack as Array<{
    route?: { path: string; stack: Array<{ handle: unknown }> };
  }>).find((l) => l.route?.path === '/threads/:threadId/browser-sessions/stream');
  expect(layer).toBeDefined();
  const route = layer!.route!;
  return route.stack[route.stack.length - 1].handle as (req: Request, res: Response) => Promise<void>;
}

function mockRes() {
  const res = {
    status: jest.fn(), end: jest.fn(), setHeader: jest.fn(), flushHeaders: jest.fn(),
    write: jest.fn(), writableEnded: false,
  };
  res.status.mockReturnValue(res);
  res.end.mockImplementation(() => { res.writableEnded = true; return res; });
  return res as unknown as Response & typeof res;
}

function req(surface?: string): Request {
  return {
    params: { threadId: THREAD },
    query: { tenantId: TENANT, ...(surface ? { surface } : {}) },
    ctx: { userId: 'user-1' },
    on: jest.fn(), off: jest.fn(),
  } as unknown as Request;
}

async function emptyStream() { /* no events */ }

beforeEach(() => {
  jest.clearAllMocks();
  resolveCallerMock.mockResolvedValue({ ok: true, caller: { accountId: 'acc-1', tenantId: TENANT, role: 'admin' } });
  getAgentThreadMock.mockResolvedValue(null);
  getLiftoffThreadMock.mockResolvedValue(null);
  getInsightsThreadMock.mockResolvedValue(null);
  teamPlanThreadExistsMock.mockResolvedValue(false);
  streamSessionEventsMock.mockReturnValue(emptyStream());
});

it('defaults to agent chat, so an older frontend keeps working unchanged', async () => {
  getAgentThreadMock.mockResolvedValue({ id: THREAD });
  const res = mockRes();
  await handler()(req(), res);
  expect(getAgentThreadMock).toHaveBeenCalledWith(THREAD, TENANT);
  expect(res.status).not.toHaveBeenCalledWith(404);
  expect(streamSessionEventsMock).toHaveBeenCalledWith({ tenantContext: { tenantId: TENANT }, threadId: THREAD });
});

it("finds a Liftoff assistant's thread on its own table", async () => {
  getLiftoffThreadMock.mockResolvedValue({ id: THREAD });
  const res = mockRes();
  await handler()(req('liftoff'), res);
  expect(getLiftoffThreadMock).toHaveBeenCalledWith(THREAD, TENANT);
  expect(getAgentThreadMock).not.toHaveBeenCalled();
  expect(res.status).not.toHaveBeenCalledWith(404);
  expect(streamSessionEventsMock).toHaveBeenCalled();
});

it("finds the Insights Manager's thread on its own table", async () => {
  getInsightsThreadMock.mockResolvedValue({ id: THREAD });
  const res = mockRes();
  await handler()(req('insights'), res);
  expect(getInsightsThreadMock).toHaveBeenCalledWith(THREAD, TENANT);
  expect(streamSessionEventsMock).toHaveBeenCalled();
});

it("confirms the Chief AI Officer's thread across the service boundary", async () => {
  teamPlanThreadExistsMock.mockResolvedValue(true);
  const res = mockRes();
  await handler()(req('team_plan'), res);
  expect(teamPlanThreadExistsMock).toHaveBeenCalledWith({
    threadId: THREAD, tenantId: TENANT, accountId: 'acc-1', role: 'admin',
  });
  expect(streamSessionEventsMock).toHaveBeenCalled();
});

it('answers 404 for a thread that exists only on a surface the caller did not name', async () => {
  // Explicit rather than a fall-through search: the same UUID could name a
  // different thread on another surface.
  getLiftoffThreadMock.mockResolvedValue({ id: THREAD });
  const res = mockRes();
  await handler()(req('agent'), res);
  expect(res.status).toHaveBeenCalledWith(404);
  expect(streamSessionEventsMock).not.toHaveBeenCalled();
});

it('rejects a surface it does not know', async () => {
  const res = mockRes();
  await handler()(req('slack'), res);
  expect(res.status).toHaveBeenCalledWith(400);
});

it('proves membership before reading any table', async () => {
  resolveCallerMock.mockResolvedValue({ ok: false, status: 403, error: 'nope' });
  const res = mockRes();
  await handler()(req('liftoff'), res);
  expect(res.status).toHaveBeenCalledWith(403);
  expect(getLiftoffThreadMock).not.toHaveBeenCalled();
});
