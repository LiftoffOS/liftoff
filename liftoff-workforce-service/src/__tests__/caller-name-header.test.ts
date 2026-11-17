// The person's name, as platform-backend sends it and this service reads it.
//
// The name is attribution, not authorization: anything malformed reads as no
// name rather than failing the turn, and nothing a client could put in it
// reaches a prompt line or a stored sender label unchanged.

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

import Fastify from 'fastify';
import {
  CALLER_NAME_HEADER,
  parseCallerNameHeader,
  resolveCallerFromHeaders,
} from '../workforce-plans/caller-context.js';
import { appendMessage, getThread } from '../workforce-plans/chat-repository.js';
import { runCAIOChatTurn } from '../workforce-plans/chat-service.js';
import { findLiveTurnId } from '../workforce-plans/turn-signal-repository.js';
import { checkAndIncrementTeamPlanRateLimit } from '../workforce-plans/rate-limiter.js';
import { registerChatStreamRoutes } from '../workforce-plans/chat-stream-router.js';
import type { FastifyRequest } from 'fastify';

const THREAD_ID = '11111111-1111-4111-8111-111111111111';
const TENANT_ID = '22222222-2222-4222-8222-222222222222';
const ACCOUNT_ID = '33333333-3333-4333-8333-333333333333';

describe('parseCallerNameHeader', () => {
  it('decodes what platform-backend encoded, including names outside Latin-1', () => {
    expect(parseCallerNameHeader(encodeURIComponent('Zoë 李'))).toBe('Zoë 李');
    expect(parseCallerNameHeader(encodeURIComponent('  Dana Reyes  '))).toBe('Dana Reyes');
  });

  it('reads nothing as nothing, and never throws on a malformed value', () => {
    expect(parseCallerNameHeader(undefined)).toBeUndefined();
    expect(parseCallerNameHeader('')).toBeUndefined();
    expect(parseCallerNameHeader('%E0%A4%A')).toBeUndefined();
    expect(parseCallerNameHeader(['a', 'b'])).toBeUndefined();
    expect(parseCallerNameHeader(encodeURIComponent('   '))).toBeUndefined();
  });

  it('drops control characters and caps the length', () => {
    expect(parseCallerNameHeader(encodeURIComponent('Dana\nReyes'))).toBe('DanaReyes');
    expect(parseCallerNameHeader(encodeURIComponent('x'.repeat(500)))).toHaveLength(200);
  });
});

describe('resolveCallerFromHeaders', () => {
  const request = (headers: Record<string, string>) => ({ headers }) as unknown as FastifyRequest;

  it('carries the name when it is sent and omits it when it is not', () => {
    const named = resolveCallerFromHeaders(request({
      'x-tenant-id': TENANT_ID, 'x-account-id': ACCOUNT_ID, 'x-tenant-role': 'member',
      [CALLER_NAME_HEADER]: encodeURIComponent('Dana Reyes'),
    }));
    expect(named).toEqual({ ok: true, caller: { tenantId: TENANT_ID, accountId: ACCOUNT_ID, role: 'member', displayName: 'Dana Reyes' } });

    const unnamed = resolveCallerFromHeaders(request({
      'x-tenant-id': TENANT_ID, 'x-account-id': ACCOUNT_ID, 'x-tenant-role': 'member',
    }));
    expect(unnamed).toEqual({ ok: true, caller: { tenantId: TENANT_ID, accountId: ACCOUNT_ID, role: 'member' } });
  });
});

describe('POST /team-plan/chat-stream', () => {
  beforeEach(() => {
    (getThread as jest.Mock).mockReset().mockResolvedValue({ id: THREAD_ID });
    (appendMessage as jest.Mock).mockReset().mockResolvedValue({ id: 'message-1' });
    (findLiveTurnId as jest.Mock).mockReset().mockResolvedValue(null);
    (checkAndIncrementTeamPlanRateLimit as jest.Mock).mockReset().mockResolvedValue({ allowed: true });
    (runCAIOChatTurn as jest.Mock).mockReset().mockImplementation(async function* () {
      yield { type: 'complete', message: null };
    });
  });

  it('hands the person\'s name to the turn, and nothing when there is none', async () => {
    const app = Fastify();
    await registerChatStreamRoutes(app);
    await app.ready();

    await app.inject({
      method: 'POST',
      url: '/team-plan/chat-stream',
      headers: {
        'x-tenant-id': TENANT_ID, 'x-account-id': ACCOUNT_ID, 'x-tenant-role': 'member',
        [CALLER_NAME_HEADER]: encodeURIComponent('Dana Reyes'),
      },
      payload: { threadId: THREAD_ID, content: 'hello' },
    });
    expect(runCAIOChatTurn).toHaveBeenCalledWith(expect.objectContaining({ callerName: 'Dana Reyes' }));

    (runCAIOChatTurn as jest.Mock).mockClear();
    await app.inject({
      method: 'POST',
      url: '/team-plan/chat-stream',
      headers: { 'x-tenant-id': TENANT_ID, 'x-account-id': ACCOUNT_ID, 'x-tenant-role': 'member' },
      payload: { threadId: THREAD_ID, content: 'hello' },
    });
    expect((runCAIOChatTurn as jest.Mock).mock.calls[0][0]).not.toHaveProperty('callerName');
  });
});
