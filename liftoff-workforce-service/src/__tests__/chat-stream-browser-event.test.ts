// POST /team-plan/chat-stream with the person's browser event: a hand-back or
// a point, beside the words they typed while driving or instead of them.
//
// The route verifies the claim through the chat service (platform-backend's
// takeovers route) before anything is written or any header is flushed: a 409 there is a
// plain 409 here, no row and no turn; a platform-backend that cannot answer
// is a 503. What checks out rides the turn, which writes the status line and
// reads the shared event text when the person sent no words.

jest.mock('../workforce-plans/chat-repository.js', () => ({
  createTurn: jest.fn(),
  getThread: jest.fn(),
  appendMessage: jest.fn(),
}));

jest.mock('../workforce-plans/chat-service.js', () => ({
  runCAIOChatTurn: jest.fn(),
  verifyBrowserEvent: jest.fn(),
}));

jest.mock('../workforce-plans/audit-log.js', () => ({
  writeAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../workforce-plans/turn-signal-repository.js', () => ({
  findLiveTurnId: jest.fn(),
  deliverUserMessage: jest.fn(),
}));

jest.mock('../workforce-plans/rate-limiter.js', () => ({
  checkAndIncrementTeamPlanRateLimit: jest.fn(),
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { getThread } from '../workforce-plans/chat-repository.js';
import { runCAIOChatTurn, verifyBrowserEvent } from '../workforce-plans/chat-service.js';
import { findLiveTurnId } from '../workforce-plans/turn-signal-repository.js';
import { checkAndIncrementTeamPlanRateLimit } from '../workforce-plans/rate-limiter.js';
import { registerChatStreamRoutes } from '../workforce-plans/chat-stream-router.js';

const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';
const HOLD = '44444444-4444-4444-8444-444444444444';

const authHeaders = {
  'x-tenant-id': TENANT_ID,
  'x-account-id': ACCOUNT_ID,
  'x-tenant-role': 'owner',
};

async function buildApp(): Promise<FastifyInstance> {
  const app = Fastify();
  await registerChatStreamRoutes(app);
  await app.ready();
  return app;
}

beforeEach(() => {
  (getThread as jest.Mock).mockReset().mockResolvedValue({ id: THREAD_ID });
  (findLiveTurnId as jest.Mock).mockReset().mockResolvedValue(null);
  (checkAndIncrementTeamPlanRateLimit as jest.Mock).mockReset().mockResolvedValue({ allowed: true });
  (verifyBrowserEvent as jest.Mock).mockReset().mockResolvedValue({ ok: true, event: { kind: 'handback', holdId: HOLD, action: null } });
  (runCAIOChatTurn as jest.Mock).mockReset().mockImplementation(async function* () {
    yield { type: 'text_delta', text: 'Picking up from the page you left.' };
    yield { type: 'complete', message: null };
  });
});

describe('a hand-back', () => {
  it('verifies the hold through platform-backend and runs the turn with the event and no words', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/team-plan/chat-stream', headers: authHeaders,
      payload: { threadId: THREAD_ID, browserHandback: { holdId: HOLD } },
    });
    expect(res.statusCode).toBe(200);
    expect(verifyBrowserEvent).toHaveBeenCalledWith({ tenantId: TENANT_ID, threadId: THREAD_ID }, 'handback', HOLD);
    expect(runCAIOChatTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: THREAD_ID, userMessage: undefined, browserEvent: { kind: 'handback', holdId: HOLD, action: null },
    }));
    expect(res.body).toContain('Picking up from the page you left.');
  });

  it('rides beside the words sent while driving, in one turn', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/team-plan/chat-stream', headers: authHeaders,
      payload: { threadId: THREAD_ID, content: 'now summarise it', browserHandback: { holdId: HOLD } },
    });
    expect(res.statusCode).toBe(200);
    expect(runCAIOChatTurn).toHaveBeenCalledTimes(1);
    expect(runCAIOChatTurn).toHaveBeenCalledWith(expect.objectContaining({
      userMessage: 'now summarise it', browserEvent: { kind: 'handback', holdId: HOLD, action: null },
    }));
  });

  it("a 409 from platform-backend is a 409 here: the hold is not this thread's, not released, or too old; no turn runs", async () => {
    (verifyBrowserEvent as jest.Mock).mockResolvedValue({ ok: false, status: 409 });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/team-plan/chat-stream', headers: authHeaders,
      payload: { threadId: THREAD_ID, browserHandback: { holdId: HOLD } },
    });
    expect(res.statusCode).toBe(409);
    expect(res.json()).toEqual({ error: 'handback_not_pending' });
    expect(runCAIOChatTurn).not.toHaveBeenCalled();
  });

  it('a platform-backend that cannot answer is a 503, and no turn runs', async () => {
    (verifyBrowserEvent as jest.Mock).mockResolvedValue({ ok: false, status: 503 });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/team-plan/chat-stream', headers: authHeaders,
      payload: { threadId: THREAD_ID, browserHandback: { holdId: HOLD } },
    });
    expect(res.statusCode).toBe(503);
    expect(runCAIOChatTurn).not.toHaveBeenCalled();
  });
});

describe('a point', () => {
  it('is verified as a point and the pointed-at control rides the turn', async () => {
    const action = { kind: 'point', role: 'link', name: 'Sports' };
    (verifyBrowserEvent as jest.Mock).mockResolvedValue({ ok: true, event: { kind: 'point', holdId: HOLD, action } });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST', url: '/team-plan/chat-stream', headers: authHeaders,
      payload: { threadId: THREAD_ID, browserPoint: { holdId: HOLD } },
    });
    expect(res.statusCode).toBe(200);
    expect(verifyBrowserEvent).toHaveBeenCalledWith({ tenantId: TENANT_ID, threadId: THREAD_ID }, 'point', HOLD);
    expect(runCAIOChatTurn).toHaveBeenCalledWith(expect.objectContaining({ browserEvent: { kind: 'point', holdId: HOLD, action } }));
  });
});

describe('the body', () => {
  it('refuses two events at once, an event without a thread, and is never the greeting', async () => {
    const app = await buildApp();
    let res = await app.inject({
      method: 'POST', url: '/team-plan/chat-stream', headers: authHeaders,
      payload: { threadId: THREAD_ID, browserHandback: { holdId: HOLD }, browserPoint: { holdId: HOLD } },
    });
    expect(res.statusCode).toBe(400);
    res = await app.inject({
      method: 'POST', url: '/team-plan/chat-stream', headers: authHeaders,
      payload: { browserHandback: { holdId: HOLD } },
    });
    expect(res.statusCode).toBe(400);
    expect(runCAIOChatTurn).not.toHaveBeenCalled();
    expect(verifyBrowserEvent).not.toHaveBeenCalled();
  });
});
