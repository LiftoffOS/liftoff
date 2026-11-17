// Distill stream router — rate-limit identity.
//
// `req.ctx.userId` is the Firebase uid the auth middleware set, never an
// account id, and the ledger keys on `account_id UUID`. Passing the uid through
// made every insert fail and the limiter fail open, so the most expensive LLM
// call in the product had no rate limit at all.

import express, { Request, Response, NextFunction } from 'express';

const mockCheckRateLimit = jest.fn();
jest.mock('../../common/chat-rate-limiter', () => ({
  checkAndIncrementChatRateLimit: (...args: unknown[]) => mockCheckRateLimit(...args),
}));

const mockGetByFirebaseUid = jest.fn();
jest.mock('../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: mockGetByFirebaseUid,
  })),
}));

const mockDistill = jest.fn();
jest.mock('../distill-service', () => ({
  distillInternalAgentWithProgress: (...args: unknown[]) => mockDistill(...args),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import { distillInternalAgentStreamRouter } from '../distill-stream-router';

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const ACCOUNT_ID = '22222222-2222-2222-2222-222222222222';
const FIREBASE_UID = 'F6wbR2SXrBhe6aMT398J38pNzb53';

const VALID_BODY = { role: 'HR Agent', responsibilities: 'Manage employee records', integrations: [] };

// Sentinel: pass NO_USER to suppress the uid. `undefined` cannot be used here,
// because an explicitly passed `undefined` fires the default argument and would
// silently re-attach the uid, turning the no-auth test green against the wrong
// code path. Same trap the a2a agent-card tests document.
const NO_USER = Symbol('no-user');

function buildApp(userId: string | typeof NO_USER = FIREBASE_UID) {
  const app = express();
  app.use(express.json());
  app.use((req: Request, _res: Response, next: NextFunction) => {
    (req as Request & { ctx?: { userId?: string } }).ctx =
      userId === NO_USER ? {} : { userId };
    next();
  });
  app.use('/distill-stream', distillInternalAgentStreamRouter);
  return app;
}

function post(app: express.Express, path: string, body: unknown): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}${path}`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then(async (res) => {
          const text = await res.text().catch(() => '');
          server.close();
          resolve({ status: res.status, text });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetByFirebaseUid.mockResolvedValue({ id: ACCOUNT_ID });
  mockCheckRateLimit.mockResolvedValue({ allowed: true, remaining: { minute: 5, hour: 30, day: 100 } });
  mockDistill.mockResolvedValue({ role: 'HR Agent' });
});

describe('rate-limit identity', () => {
  it('rate limits on the resolved account id, not the Firebase uid', async () => {
    const app = buildApp();
    await post(app, `/distill-stream?tenantId=${TENANT_ID}`, VALID_BODY);

    expect(mockGetByFirebaseUid).toHaveBeenCalledWith(FIREBASE_UID);
    expect(mockCheckRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: TENANT_ID, accountId: ACCOUNT_ID }),
    );
    // The uid must never reach the ledger.
    expect(mockCheckRateLimit).not.toHaveBeenCalledWith(
      expect.objectContaining({ accountId: FIREBASE_UID }),
    );
  });

  it('returns 401 when the uid resolves to no account', async () => {
    mockGetByFirebaseUid.mockResolvedValue(null);
    const app = buildApp();
    const res = await post(app, `/distill-stream?tenantId=${TENANT_ID}`, VALID_BODY);

    expect(res.status).toBe(401);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('returns 401 when there is no authenticated uid', async () => {
    const app = buildApp(NO_USER);
    const res = await post(app, `/distill-stream?tenantId=${TENANT_ID}`, VALID_BODY);

    expect(res.status).toBe(401);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });

  it('returns 400 for a non-UUID tenantId rather than letting the limiter throw', async () => {
    const app = buildApp();
    const res = await post(app, '/distill-stream?tenantId=not-a-uuid', VALID_BODY);

    expect(res.status).toBe(400);
    expect(mockCheckRateLimit).not.toHaveBeenCalled();
  });
});
