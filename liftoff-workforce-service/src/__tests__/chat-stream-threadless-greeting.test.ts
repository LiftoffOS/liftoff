// The greeting the plan page opens with, which has no thread and creates none.
//
// Opening the page used to create a thread and stream the greeting into it, so
// a visit nobody typed into left a permanent row behind. The greeting is still
// the real thing — a workspace-grounded turn from the Chief AI Officer, not a
// clock string — it simply has nowhere to be filed until somebody replies.

jest.mock('../workforce-plans/chat-repository.js', () => ({
  createTurn: jest.fn(),
  getThread: jest.fn(),
  appendMessage: jest.fn(),
}));

jest.mock('../workforce-plans/chat-service.js', () => ({
  runCAIOChatTurn: jest.fn(),
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
import { appendMessage, getThread } from '../workforce-plans/chat-repository.js';
import { runCAIOChatTurn } from '../workforce-plans/chat-service.js';
import { findLiveTurnId } from '../workforce-plans/turn-signal-repository.js';
import { checkAndIncrementTeamPlanRateLimit } from '../workforce-plans/rate-limiter.js';
import { registerChatStreamRoutes } from '../workforce-plans/chat-stream-router.js';

const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';

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
  (appendMessage as jest.Mock).mockReset().mockResolvedValue({ id: 'message-1' });
  (findLiveTurnId as jest.Mock).mockReset().mockResolvedValue(null);
  (checkAndIncrementTeamPlanRateLimit as jest.Mock)
    .mockReset()
    .mockResolvedValue({ allowed: true });
  (runCAIOChatTurn as jest.Mock).mockReset().mockImplementation(async function* () {
    yield { type: 'text_delta', text: 'You have Slack and GitHub connected.' };
    yield { type: 'complete', message: null };
  });
});

describe('POST /team-plan/chat-stream with no threadId', () => {
  it('runs the greeting turn with no thread', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/team-plan/chat-stream',
      headers: authHeaders,
      payload: {},
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('event: text_delta');
    expect(res.body).toContain('You have Slack and GitHub connected.');
    expect(runCAIOChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: null, tenantId: TENANT_ID, userMessage: undefined }),
    );
  });

  it('looks up no thread and claims no turn', async () => {
    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/team-plan/chat-stream',
      headers: authHeaders,
      payload: {},
    });

    expect(getThread).not.toHaveBeenCalled();
    expect(findLiveTurnId).not.toHaveBeenCalled();
  });

  it('is still metered — a surface that is free to open is worth metering', async () => {
    (checkAndIncrementTeamPlanRateLimit as jest.Mock).mockResolvedValue({
      allowed: false,
      retryAfter: 30,
    });

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/team-plan/chat-stream',
      headers: authHeaders,
      payload: {},
    });

    // A plain JSON 429, not an SSE error frame the client has to dig out.
    expect(res.statusCode).toBe(429);
    expect(runCAIOChatTurn).not.toHaveBeenCalled();
  });

  it('still requires the caller headers', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/team-plan/chat-stream',
      payload: {},
    });

    expect(res.statusCode).toBe(401);
    expect(runCAIOChatTurn).not.toHaveBeenCalled();
  });

  it('refuses a message with no conversation to belong to', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/team-plan/chat-stream',
      headers: authHeaders,
      payload: { content: 'plan me a support team' },
    });

    expect(res.statusCode).toBe(400);
    expect(runCAIOChatTurn).not.toHaveBeenCalled();
  });
});

describe('POST /team-plan/chat-stream greeting WITH a threadId', () => {
  it('still checks the thread, so callers holding a transcript are unaffected', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/team-plan/chat-stream',
      headers: authHeaders,
      payload: { threadId: THREAD_ID },
    });

    expect(res.statusCode).toBe(200);
    expect(getThread).toHaveBeenCalledWith(THREAD_ID, TENANT_ID);
    expect(runCAIOChatTurn).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: THREAD_ID }),
    );
  });

  it('404s when that thread is not visible to the caller', async () => {
    (getThread as jest.Mock).mockResolvedValue(null);

    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/team-plan/chat-stream',
      headers: authHeaders,
      payload: { threadId: THREAD_ID },
    });

    expect(res.statusCode).toBe(404);
    expect(runCAIOChatTurn).not.toHaveBeenCalled();
  });
});
