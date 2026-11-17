// The chat-stream route's side of a hand-over: the two fields platform-backend
// sends with a delegated turn reach the turn, and the two frames a hand-over
// yields reach the client in Liftoff's shape.

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
  'x-tenant-role': 'member',
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
  (checkAndIncrementTeamPlanRateLimit as jest.Mock).mockReset().mockResolvedValue({ allowed: true });
  (runCAIOChatTurn as jest.Mock).mockReset().mockImplementation(async function* () {
    yield { type: 'complete', message: null };
  });
});

describe('a delegated turn', () => {
  it('hands the forwarder and the hand-over flag to the turn, the forwarder only beside the note', async () => {
    const app = await buildApp();
    await app.inject({
      method: 'POST',
      url: '/team-plan/chat-stream',
      headers: authHeaders,
      payload: {
        threadId: THREAD_ID,
        content: 'pause it',
        forwardedContext: 'Insights Manager shared background from the conversation so far\n\nIt costs the most.',
        forwardedBy: { id: 'insights', label: 'Insights Manager' },
        handover: true,
      },
    });
    expect(runCAIOChatTurn).toHaveBeenCalledWith(expect.objectContaining({
      threadId: THREAD_ID,
      userMessage: 'pause it',
      forwardedContext: 'Insights Manager shared background from the conversation so far\n\nIt costs the most.',
      forwardedBy: { id: 'insights', label: 'Insights Manager' },
      handover: true,
    }));

    // A forwarder with no note is nobody's, and an ordinary turn carries no
    // flag at all rather than a false one.
    (runCAIOChatTurn as jest.Mock).mockClear();
    await app.inject({
      method: 'POST',
      url: '/team-plan/chat-stream',
      headers: authHeaders,
      payload: { threadId: THREAD_ID, content: 'hello', forwardedBy: { id: 'liftoff', label: 'Liftoff' } },
    });
    const args = (runCAIOChatTurn as jest.Mock).mock.calls[0][0] as Record<string, unknown>;
    expect(args.forwardedBy).toBeNull();
    expect(args).not.toHaveProperty('handover');
  });

  it('rejects a forwarder that is not an id and a label', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/team-plan/chat-stream',
      headers: authHeaders,
      payload: { threadId: THREAD_ID, content: 'hello', forwardedContext: 'note', forwardedBy: 'liftoff' },
    });
    expect(res.statusCode).toBe(400);
    expect(runCAIOChatTurn).not.toHaveBeenCalled();
  });
});

describe('the two hand-over frames', () => {
  it("cross in Liftoff's shape", async () => {
    (runCAIOChatTurn as jest.Mock).mockImplementation(async function* () {
      yield { type: 'delegation_started', author: 'insights', authorLabel: 'Insights Manager' };
      yield { type: 'text_delta', text: 'Twelve.' };
      yield {
        type: 'delegation_paused',
        author: 'insights',
        authorLabel: 'Insights Manager',
        delegateThreadId: 'it-1',
        reason: 'Insights Manager is waiting on an approval before it can continue.',
        message: { id: 'm-3', messageType: 'hitl_status' },
      };
    });
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/team-plan/chat-stream',
      headers: authHeaders,
      payload: { threadId: THREAD_ID, content: 'how many runs' },
    });

    expect(res.body).toContain(
      'event: delegation_started\ndata: {"author":"insights","authorLabel":"Insights Manager"}\n\n',
    );
    expect(res.body).toContain(
      'event: delegation_paused\ndata: {"author":"insights","authorLabel":"Insights Manager","delegateThreadId":"it-1",'
      + '"reason":"Insights Manager is waiting on an approval before it can continue.","message":{"id":"m-3","messageType":"hitl_status"}}\n\n',
    );
    // The stream still closes with the frame every surface sends.
    expect(res.body.endsWith('event: done\ndata: {}\n\n')).toBe(true);
  });
});
