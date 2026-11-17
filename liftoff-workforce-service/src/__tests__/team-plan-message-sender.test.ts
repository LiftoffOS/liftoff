// Who sent each message to the Chief AI Officer (migration 027).
//
// The repository's input is a discriminated union: a `role: 'user'` write
// cannot compile without a `senderAccountId: string`, which is the first test
// and needs no runtime (this repo type-checks its tests). The rest asserts
// that each of the three human writers hands the repository the CALLER's
// account id — the one the request authenticated with — and not merely some
// value. The REST and streaming routes are driven through Fastify with the
// trusted headers here; the chat service is driven for real in
// chat-service-user-message-sender.test.ts.

jest.mock('../workforce-plans/chat-repository.js', () => ({
  createTurn: jest.fn(),
  getThread: jest.fn(),
  appendMessage: jest.fn(),
  createThread: jest.fn(),
  deleteThread: jest.fn(),
  exportMessages: jest.fn(),
  exportThreads: jest.fn(),
  EXPORT_FEED_MAX_LIMIT: 200,
  getUnreadThreadCount: jest.fn(),
  listMessages: jest.fn(),
  listThreads: jest.fn(),
  markThreadRead: jest.fn(),
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

import { readFileSync } from 'fs';
import { join } from 'path';
import Fastify, { type FastifyInstance } from 'fastify';
import { appendMessage, getThread } from '../workforce-plans/chat-repository.js';
import type { AppendMessageInput } from '../workforce-plans/chat-repository.js';
import { deliverUserMessage, findLiveTurnId } from '../workforce-plans/turn-signal-repository.js';
import { registerChatRoutes } from '../workforce-plans/chat-router.js';
import { registerChatStreamRoutes } from '../workforce-plans/chat-stream-router.js';

const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const CALLER = '33333333-3333-4333-8333-333333333333';

const headersFor = (accountId: string) => ({
  'x-tenant-id': TENANT_ID,
  'x-account-id': accountId,
  'x-tenant-role': 'member',
});

beforeEach(() => {
  (getThread as jest.Mock).mockReset().mockResolvedValue({ id: THREAD_ID, tenantId: TENANT_ID, accountId: CALLER });
  (appendMessage as jest.Mock).mockReset().mockResolvedValue({ id: 'message-1' });
  (findLiveTurnId as jest.Mock).mockReset().mockResolvedValue(null);
  (deliverUserMessage as jest.Mock).mockReset().mockResolvedValue('delivered');
});

describe('the repository input', () => {
  it('cannot express a user message without a sender', () => {
    // Compile-time: the arm with role 'user' requires a string senderAccountId
    // and the assistant arm has none. The @ts-expect-error lines are the test.
    const user: AppendMessageInput = {
      threadId: THREAD_ID, tenantId: TENANT_ID, role: 'user', senderAccountId: CALLER, content: 'x',
    };
    const assistant: AppendMessageInput = {
      threadId: THREAD_ID, tenantId: TENANT_ID, role: 'assistant', content: 'y',
    };
    // @ts-expect-error a user message needs its sender
    const missing: AppendMessageInput = { threadId: THREAD_ID, tenantId: TENANT_ID, role: 'user', content: 'z' };
    // @ts-expect-error a null sender is not a sender
    const nullable: AppendMessageInput = { threadId: THREAD_ID, tenantId: TENANT_ID, role: 'user', senderAccountId: null, content: 'z' };
    // @ts-expect-error the assistant arm carries no sender
    const assistantWithSender: AppendMessageInput = { threadId: THREAD_ID, tenantId: TENANT_ID, role: 'assistant', senderAccountId: CALLER, content: 'z' };
    expect([user, assistant, missing, nullable, assistantWithSender]).toHaveLength(5);
  });
});

describe('POST /team-plan/threads/:threadId/messages', () => {
  it("passes the caller's account id as the sender", async () => {
    const app: FastifyInstance = Fastify();
    await registerChatRoutes(app);
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: `/team-plan/threads/${THREAD_ID}/messages`,
      headers: headersFor(CALLER),
      payload: { content: 'Plan me a support pod.' },
    });
    expect(res.statusCode).toBe(201);
    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', senderAccountId: CALLER, threadId: THREAD_ID }),
    );
    await app.close();
  });
});

describe('POST /team-plan/chat-stream while a turn is running', () => {
  it("persists the interrupt with the caller's account id as the sender", async () => {
    (findLiveTurnId as jest.Mock).mockResolvedValue('turn-live');
    const app: FastifyInstance = Fastify();
    await registerChatStreamRoutes(app);
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/team-plan/chat-stream',
      headers: headersFor(CALLER),
      payload: { threadId: THREAD_ID, content: 'actually, make it cheaper' },
    });
    expect(res.statusCode).toBe(200);
    expect(appendMessage).toHaveBeenCalledWith(
      expect.objectContaining({ role: 'user', senderAccountId: CALLER }),
    );
    await app.close();
  });
});

describe('the chat service (source contract)', () => {
  const CHAT_SERVICE = readFileSync(join(__dirname, '..', 'workforce-plans', 'chat-service.ts'), 'utf-8');

  it('writes no sender on any assistant row', () => {
    // Every other appendMessage in the file is the Chief AI Officer speaking.
    const calls = CHAT_SERVICE.split('appendMessage({').slice(1);
    const assistantCalls = calls.filter((c) => /role:\s*'assistant'/.test(c.slice(0, 400)));
    expect(assistantCalls.length).toBeGreaterThan(0);
    for (const c of assistantCalls) {
      expect(c.slice(0, 400)).not.toContain('senderAccountId');
    }
  });
});
