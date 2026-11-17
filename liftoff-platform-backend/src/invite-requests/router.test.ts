// Invite Requests Router Tests
// Per implementation plan 1f: auth, success, rate limit, email sending, Zod validation

import { Request, Response } from 'express';

// Mock dependencies
const mockSendEmail = jest.fn();
const mockQuery = jest.fn();

jest.mock('../infrastructure/email', () => ({
  sendEmail: (...args: unknown[]) => mockSendEmail(...args),
  buildEmail: (type: string, _data: unknown) => ({ subject: `Test ${type}`, html: '<p>test</p>' }),
}));

jest.mock('../infrastructure/email/sanitize', () => ({
  escapeHtml: (text: string) => text,
  sanitizeForEmail: (text: string) => text,
}));

jest.mock('../infrastructure/database', () => ({
  getPool: () => ({ query: mockQuery }),
}));

jest.mock('../infrastructure/logging', () => ({
  log: { error: jest.fn(), info: jest.fn() },
}));

const mockGetByFirebaseUid = jest.fn();
jest.mock('../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: mockGetByFirebaseUid,
  })),
}));

jest.mock('stripe', () => ({
  __esModule: true,
  default: jest.fn(() => ({
    customers: { create: jest.fn(), update: jest.fn() },
    subscriptions: { create: jest.fn(), update: jest.fn(), cancel: jest.fn() },
  })),
}));
jest.mock('../infrastructure/secrets', () => ({
  getStripeSecretKey: jest.fn().mockResolvedValue('sk_test_mock'),
}));

import { inviteRequestsRouter } from './router';
import { createMockAccount } from '../test-utils/mocks';

// Extract the POST / handler from the router stack
function getRouteHandler() {
  const stack = (inviteRequestsRouter as any).stack;
  for (const layer of stack) {
    if (layer.route && layer.route.path === '/') {
      const postHandlers = layer.route.stack.filter(
        (l: any) => l.method === 'post'
      );
      return postHandlers[postHandlers.length - 1].handle;
    }
  }
  return null;
}

function createMockReqRes(overrides: { body?: unknown; user?: any }) {
  const req = {
    method: 'POST',
    body: overrides.body || {},
    user: overrides.user,
    log: { info: jest.fn(), error: jest.fn() },
  } as unknown as Request;

  const res = {
    status: jest.fn().mockReturnThis(),
    json: jest.fn().mockReturnThis(),
  } as unknown as Response;

  return { req, res };
}

describe('POST /api/invite-requests', () => {
  const handler = getRouteHandler();
  const mockUser = { uid: 'test-uid', email: 'person@example.com', emailVerified: true };

  beforeEach(() => {
    jest.clearAllMocks();
  });

  it('should return 401 without authenticated user', async () => {
    const { req, res } = createMockReqRes({ body: {}, user: undefined });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(401);
  });

  it('should return {success: true} on valid request', async () => {
    const account = createMockAccount({ email: 'person@example.com' });
    mockGetByFirebaseUid.mockResolvedValue(account);
    mockQuery
      .mockResolvedValueOnce({ rows: [{ invite_requested_at: null }] })
      .mockResolvedValueOnce({ rows: [] });
    mockSendEmail.mockResolvedValue('msg_id');

    const { req, res } = createMockReqRes({ body: {}, user: mockUser });

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('should send email to contact@example.com', async () => {
    const account = createMockAccount({ email: 'person@example.com', firstName: 'Jane', lastName: 'Doe' });
    mockGetByFirebaseUid.mockResolvedValue(account);
    mockQuery
      .mockResolvedValueOnce({ rows: [{ invite_requested_at: null }] })
      .mockResolvedValueOnce({ rows: [] });
    mockSendEmail.mockResolvedValue('msg_id');

    const { req, res } = createMockReqRes({ body: {}, user: mockUser });

    await handler(req, res);

    expect(mockSendEmail).toHaveBeenCalledWith(expect.objectContaining({
      to: 'contact@example.com',
      emailType: 'invite-request',
      replyTo: 'person@example.com',
    }));
  });

  it('should return 429 when rate limited (request within 1 hour)', async () => {
    const account = createMockAccount({ email: 'person@example.com' });
    mockGetByFirebaseUid.mockResolvedValue(account);
    const recentTimestamp = new Date(Date.now() - 30 * 60 * 1000); // 30 minutes ago
    mockQuery.mockResolvedValueOnce({ rows: [{ invite_requested_at: recentTimestamp }] });

    const { req, res } = createMockReqRes({ body: {}, user: mockUser });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(429);
    expect(res.json).toHaveBeenCalledWith({ error: 'Please wait before requesting again' });
  });

  it('should allow request after rate limit window expires', async () => {
    const account = createMockAccount({ email: 'person@example.com' });
    mockGetByFirebaseUid.mockResolvedValue(account);
    const oldTimestamp = new Date(Date.now() - 2 * 60 * 60 * 1000); // 2 hours ago
    mockQuery
      .mockResolvedValueOnce({ rows: [{ invite_requested_at: oldTimestamp }] })
      .mockResolvedValueOnce({ rows: [] });
    mockSendEmail.mockResolvedValue('msg_id');

    const { req, res } = createMockReqRes({ body: {}, user: mockUser });

    await handler(req, res);

    expect(res.json).toHaveBeenCalledWith({ success: true });
  });

  it('should reject unknown fields in body (Zod strict)', async () => {
    const { req, res } = createMockReqRes({
      body: { extraField: 'should be rejected' },
      user: mockUser,
    });

    await handler(req, res);

    expect(res.status).toHaveBeenCalledWith(400);
  });
});
