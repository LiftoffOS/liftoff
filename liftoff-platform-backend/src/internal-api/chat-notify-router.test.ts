// Team-plan reply notifications, on workforce-service's behalf.
//
// The interesting properties are access — only the workforce token gets in —
// and that a delivery problem never reads as a broken endpoint. The caller is
// fire-and-forget on its side, so a 500 here would be an alarm nobody hears
// while a 202 for work that silently failed would hide the same thing worse.

import express from 'express';

jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockNotify = jest.fn();
jest.mock('../notifications', () => ({
  notifyPlatformChatReply: (...a: unknown[]) => mockNotify(...a),
}));

import { chatNotifyInternalRouter } from './chat-notify-router';

const TOKEN = 'workforce-token-under-test';
const TENANT_ID = '22222222-2222-2222-2222-222222222222';
const ACCOUNT_ID = '55555555-5555-5555-5555-555555555555';
const THREAD_ID = '77777777-7777-7777-7777-777777777777';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/chat-notify', chatNotifyInternalRouter);
  return app;
}

function post(
  app: express.Express,
  body: unknown,
  token?: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}/api/internal/chat-notify/team-plan-reply`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(token ? { 'x-service-auth': token } : {}),
        },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          const b = await res.json().catch(() => ({}));
          server.close();
          resolve({ status: res.status, body: b as Record<string, unknown> });
        })
        .catch((err) => {
          server.close();
          reject(err);
        });
    });
  });
}

const VALID_BODY = {
  tenantId: TENANT_ID,
  accountId: ACCOUNT_ID,
  threadId: THREAD_ID,
  text: 'Here is the plan.',
};

beforeEach(() => {
  jest.clearAllMocks();
  process.env['WORKFORCE_SERVICE_TOKEN'] = TOKEN;
  mockNotify.mockResolvedValue(undefined);
});

describe('POST /api/internal/chat-notify/team-plan-reply', () => {
  it('notifies the person who asked, on the team plan surface', async () => {
    const res = await post(buildApp(), VALID_BODY, TOKEN);
    expect(res.status).toBe(202);
    expect(mockNotify).toHaveBeenCalledWith({
      tenantId: TENANT_ID,
      surface: 'team_plan',
      threadId: THREAD_ID,
      accountId: ACCOUNT_ID,
      text: 'Here is the plan.',
      via: null,
    });
  });

  // The surface is fixed by the route, never read off the body: this endpoint
  // exists for the one surface that cannot notify in-process, and accepting a
  // caller's surface would let it mint links for the three that can.
  it('ignores a surface the caller tries to name', async () => {
    await post(buildApp(), { ...VALID_BODY, surface: 'agent' }, TOKEN);
    expect(mockNotify.mock.calls[0][0].surface).toBe('team_plan');
  });

  it('turns away a caller with no token', async () => {
    const res = await post(buildApp(), VALID_BODY);
    expect(res.status).toBe(401);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it('turns away a caller with the wrong token', async () => {
    const res = await post(buildApp(), VALID_BODY, 'not-the-token');
    expect(res.status).toBe(401);
    expect(mockNotify).not.toHaveBeenCalled();
  });

  it.each([
    ['a non-uuid tenant', { ...VALID_BODY, tenantId: 'nope' }],
    ['a non-uuid account', { ...VALID_BODY, accountId: 'nope' }],
    ['a non-uuid thread', { ...VALID_BODY, threadId: 'nope' }],
    ['empty text', { ...VALID_BODY, text: '' }],
    ['text past the cap', { ...VALID_BODY, text: 'x'.repeat(4001) }],
  ])('rejects %s', async (_label, body) => {
    const res = await post(buildApp(), body, TOKEN);
    expect(res.status).toBe(400);
    expect(mockNotify).not.toHaveBeenCalled();
  });
});
