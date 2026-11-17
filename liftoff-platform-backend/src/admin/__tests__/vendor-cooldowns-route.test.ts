// GET /api/admin/vendor-cooldowns: the credentials the capability path is not
// using right now. Behind the admin gate — it names credential failure states
// and is deliberately not one of the public state reads — and it returns the
// operator's view with no tenant or connector ids in it.

import express from 'express';
import request from 'supertest';

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(() => ({ query: jest.fn().mockResolvedValue({ rows: [] }) })),
  withAdminScope: jest.fn(),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));
// The real gate is what makes the route admin-only; here it is a stand-in
// that refuses without a header, so the test proves the route sits BEHIND it
// rather than beside it.
jest.mock('../middleware', () => ({
  adminAuthMiddleware: jest.fn((req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (req.headers['x-admin-test'] !== 'yes') return res.status(401).json({ error: 'admin auth required' });
    (req as express.Request & { adminAccount?: unknown }).adminAccount = { id: 'admin-1', email: 'ops@example.com' };
    return next();
  }),
  logAdminAction: jest.fn(),
}));
jest.mock('../../capability-discovery/vendor-gate', () => ({
  operatorCooldownView: jest.fn(),
}));

import { adminRouter } from '../router';
import { operatorCooldownView } from '../../capability-discovery/vendor-gate';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request).ctx = { requestId: 'test', operation: 'test' };
    next();
  });
  app.use('/api/admin', adminRouter);
  return app;
}

beforeEach(() => jest.clearAllMocks());

describe('GET /api/admin/vendor-cooldowns', () => {
  it('is refused without admin authentication', async () => {
    await request(buildApp()).get('/api/admin/vendor-cooldowns').expect(401);
    expect(operatorCooldownView).not.toHaveBeenCalled();
  });

  it('returns the operator view — platform parks individually, workspace parks as counts — with no ids', async () => {
    (operatorCooldownView as jest.Mock).mockResolvedValue({
      platform: [{ connectorType: 'tikhub', scope: 'platform', reason: 'payment', expiresAt: '2026-09-18T10:09:00.000Z' }],
      workspace: [{ connectorType: 'apify', scope: 'workspace', reason: 'auth', expiresWithinMinutes: 5, count: 2 }],
    });
    const res = await request(buildApp()).get('/api/admin/vendor-cooldowns').set('x-admin-test', 'yes').expect(200);
    expect(res.body).toEqual({
      data: {
        platform: [{ connectorType: 'tikhub', scope: 'platform', reason: 'payment', expiresAt: '2026-09-18T10:09:00.000Z' }],
        workspace: [{ connectorType: 'apify', scope: 'workspace', reason: 'auth', expiresWithinMinutes: 5, count: 2 }],
      },
    });
    expect(JSON.stringify(res.body)).not.toMatch(/tenant|connector:|credential_ref/);
  });
});
