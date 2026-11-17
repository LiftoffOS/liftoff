// A person's message on a thread cancels the continuations waiting for it,
// before the live-turn check, so the work they queued does not start after
// they have moved on; a message delivered to a live turn cancels them too,
// since a running continuation holds the turn and hears the message.

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
jest.mock('../workforce-plans/chat-continuations.js', () => ({
  cancelThreadContinuations: jest.fn(),
}));

import Fastify, { type FastifyInstance } from 'fastify';
import { appendMessage, getThread } from '../workforce-plans/chat-repository.js';
import { runCAIOChatTurn } from '../workforce-plans/chat-service.js';
import { deliverUserMessage, findLiveTurnId } from '../workforce-plans/turn-signal-repository.js';
import { checkAndIncrementTeamPlanRateLimit } from '../workforce-plans/rate-limiter.js';
import { cancelThreadContinuations } from '../workforce-plans/chat-continuations.js';
import { registerChatStreamRoutes } from '../workforce-plans/chat-stream-router.js';

const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';

const authHeaders = { 'x-tenant-id': TENANT_ID, 'x-account-id': ACCOUNT_ID, 'x-tenant-role': 'member' };

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
  (deliverUserMessage as jest.Mock).mockReset().mockResolvedValue('delivered');
  (checkAndIncrementTeamPlanRateLimit as jest.Mock).mockReset().mockResolvedValue({ allowed: true });
  (cancelThreadContinuations as jest.Mock).mockReset().mockResolvedValue(0);
  (runCAIOChatTurn as jest.Mock).mockReset().mockImplementation(async function* () {
    yield { type: 'complete', message: null };
  });
});

describe('a person\'s message and the continuations waiting on the thread', () => {
  it('cancels them before the live-turn check, then runs the turn', async () => {
    const app = await buildApp();
    await app.inject({ method: 'POST', url: '/team-plan/chat-stream', headers: authHeaders, payload: { threadId: THREAD_ID, content: 'Stop; do the other thing.' } });
    expect(cancelThreadContinuations).toHaveBeenCalledWith(TENANT_ID, THREAD_ID);
    expect((cancelThreadContinuations as jest.Mock).mock.invocationCallOrder[0]).toBeLessThan((findLiveTurnId as jest.Mock).mock.invocationCallOrder[0]);
    expect(runCAIOChatTurn).toHaveBeenCalled();
    await app.close();
  });

  it('cancels them when the message is delivered to a live turn instead', async () => {
    (findLiveTurnId as jest.Mock).mockResolvedValue('turn-live');
    const app = await buildApp();
    await app.inject({ method: 'POST', url: '/team-plan/chat-stream', headers: authHeaders, payload: { threadId: THREAD_ID, content: 'And the totals.' } });
    expect(cancelThreadContinuations).toHaveBeenCalledWith(TENANT_ID, THREAD_ID);
    expect(deliverUserMessage).toHaveBeenCalled();
    expect(runCAIOChatTurn).not.toHaveBeenCalled();
    await app.close();
  });

  it('a threadless greeting cancels nothing', async () => {
    const app = await buildApp();
    await app.inject({ method: 'POST', url: '/team-plan/chat-stream', headers: authHeaders, payload: {} });
    expect(cancelThreadContinuations).not.toHaveBeenCalled();
    await app.close();
  });
});
