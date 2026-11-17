// The CAIO chat-stream request flow once a turn is already running (ADR-041).
//
// Order is the whole point: the check for a live turn runs before anything
// starts a second one. Two turns on one thread would append to the same
// transcript and argue with each other, which is what this endpoint did until
// the claim row got a reader.

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

import Fastify, { type FastifyInstance } from 'fastify';
import { appendMessage, getThread } from '../workforce-plans/chat-repository.js';
import { runCAIOChatTurn } from '../workforce-plans/chat-service.js';
import {
  deliverUserMessage,
  findLiveTurnId,
} from '../workforce-plans/turn-signal-repository.js';
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
  (runCAIOChatTurn as jest.Mock).mockReset().mockImplementation(async function* () {
    yield { type: 'text_delta', text: 'hello' };
  });
  (findLiveTurnId as jest.Mock).mockReset().mockResolvedValue(null);
  (deliverUserMessage as jest.Mock).mockReset().mockResolvedValue('delivered');
});

describe('POST /team-plan/chat-stream while a turn is running', () => {
  it('delivers the message into the running turn and starts no second turn', async () => {
    (findLiveTurnId as jest.Mock).mockResolvedValue('turn-live');
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/team-plan/chat-stream',
      headers: authHeaders,
      payload: { threadId: THREAD_ID, content: 'actually, make it cheaper' },
    });

    expect(res.statusCode).toBe(200);
    // Acknowledged as an SSE frame, so every chat surface keeps one client path.
    expect(res.body).toContain('event: interrupt_delivered');
    expect(deliverUserMessage).toHaveBeenCalledWith(
      TENANT_ID,
      'turn-live',
      expect.objectContaining({
        text: 'actually, make it cheaper',
        senderAccountId: ACCOUNT_ID,
      }),
    );
    // The message the person watched being accepted is in the transcript too.
    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', content: 'actually, make it cheaper' }),
    );
    expect(runCAIOChatTurn).not.toHaveBeenCalled();
    await app.close();
  });

  it('starts a normal turn when the run ended in the moment before delivery', async () => {
    // The foreign key rejected the message because the turn had just finished.
    // The person meant to say something, so answer it rather than telling them
    // to wait for a turn that is already over.
    (findLiveTurnId as jest.Mock).mockResolvedValue('turn-live');
    (deliverUserMessage as jest.Mock).mockResolvedValue('no_turn');
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/team-plan/chat-stream',
      headers: authHeaders,
      payload: { threadId: THREAD_ID, content: 'actually, make it cheaper' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('event: text_delta');
    expect(runCAIOChatTurn).toHaveBeenCalled();
    // The turn that answers it persists it; the interrupt path must not have.
    expect(appendMessage).not.toHaveBeenCalled();
    await app.close();
  });

  it('answers 409 for a greeting while a turn is running', async () => {
    // A greeting carries nothing to deliver, so there is nothing to fold in.
    (findLiveTurnId as jest.Mock).mockResolvedValue('turn-live');
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/team-plan/chat-stream',
      headers: authHeaders,
      payload: { threadId: THREAD_ID },
    });

    expect(res.statusCode).toBe(409);
    expect(runCAIOChatTurn).not.toHaveBeenCalled();
    await app.close();
  });

  it('runs the turn normally when the thread is idle', async () => {
    const app = await buildApp();
    const res = await app.inject({
      method: 'POST',
      url: '/team-plan/chat-stream',
      headers: authHeaders,
      payload: { threadId: THREAD_ID, content: 'hello' },
    });

    expect(res.statusCode).toBe(200);
    expect(res.body).toContain('event: text_delta');
    expect(deliverUserMessage).not.toHaveBeenCalled();
    await app.close();
  });

  // The stream has a fixed lifetime, and the turn is told when to have its
  // reply on its way: the stream's end less the room for the model call in
  // flight and the closing call. A turn told nothing would finish after the
  // person had already been told it failed.
  it('tells the turn when its reply must be on its way, inside the stream cap', async () => {
    const app = await buildApp();
    const before = Date.now();
    await app.inject({
      method: 'POST',
      url: '/team-plan/chat-stream',
      headers: authHeaders,
      payload: { threadId: THREAD_ID, content: 'hello' },
    });
    const after = Date.now();

    const input = (runCAIOChatTurn as jest.Mock).mock.calls[0][0] as { replyDeadlineAt?: number };
    const expected = 10 * 60 * 1000 - 90_000;
    expect(input.replyDeadlineAt).toBeGreaterThanOrEqual(before + expected);
    expect(input.replyDeadlineAt).toBeLessThanOrEqual(after + expected);
    await app.close();
  });
});

describe('client disconnect', () => {
  it('finishes the turn after the browser goes away', async () => {
    // 28c84aa / ADR-041 line 61: a lost SSE consumer must not end the turn.
    // The reply is what the turn is for, and it was already paid for.
    let drainedToEnd = false;
    (runCAIOChatTurn as jest.Mock).mockImplementation(async function* () {
      yield { type: 'text_delta', text: 'first' };
      await new Promise(resolve => setTimeout(resolve, 120));
      yield { type: 'text_delta', text: 'second' };
      drainedToEnd = true;
    });

    const app = await buildApp();
    await app.listen({ port: 0, host: '127.0.0.1' });
    const address = app.server.address() as { port: number };

    const controller = new AbortController();
    const request = fetch(`http://127.0.0.1:${address.port}/team-plan/chat-stream`, {
      method: 'POST',
      headers: { ...authHeaders, 'content-type': 'application/json' },
      body: JSON.stringify({ threadId: THREAD_ID, content: 'hello' }),
      signal: controller.signal,
    });

    // Let the first frame go out, then drop the socket the way a closed tab does.
    await new Promise(resolve => setTimeout(resolve, 40));
    controller.abort();
    await request.catch(() => undefined);

    await new Promise(resolve => setTimeout(resolve, 300));
    expect(drainedToEnd).toBe(true);
    await app.close();
  });
});
