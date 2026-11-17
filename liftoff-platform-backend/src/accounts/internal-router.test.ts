// HMAC-protected /api/internal/accounts/check-deletion-history endpoint.
// Validates the lookup against the deletion ledger + the HMAC signature
// check itself (matches the BILLING_SERVICE_TOKEN signing convention).

const mockFindDeletionLedger = jest.fn();

jest.mock('./repository', () => ({
  AccountRepository: jest.fn().mockImplementation(() => ({
    findDeletionLedgerByEmailHash: mockFindDeletionLedger,
  })),
}));

jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import express, { type Express } from 'express';
import { createHmac } from 'node:crypto';
import { accountsInternalRouter } from './internal-router';

const TOKEN = 'test-billing-token';
const PATH = '/api/internal/accounts/check-deletion-history';

function buildApp(): Express {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/accounts', accountsInternalRouter);
  return app;
}

function sign(method: string, path: string, body: object): { ts: string; sig: string } {
  const ts = String(Date.now());
  const bodyStr = JSON.stringify(body ?? {});
  const sig = createHmac('sha256', TOKEN).update(`${method}\n${path}\n${ts}\n${bodyStr}`).digest('hex');
  return { ts, sig };
}

describe('POST /api/internal/accounts/check-deletion-history', () => {
  const originalEnv = process.env.BILLING_SERVICE_TOKEN;
  beforeAll(() => { process.env.BILLING_SERVICE_TOKEN = TOKEN; });
  afterAll(() => { if (originalEnv === undefined) delete process.env.BILLING_SERVICE_TOKEN; else process.env.BILLING_SERVICE_TOKEN = originalEnv; });
  beforeEach(() => { jest.clearAllMocks(); });

  it('returns matched: false for unknown email', async () => {
    mockFindDeletionLedger.mockResolvedValueOnce(null);
    const app = buildApp();
    const body = { emailHash: 'a'.repeat(64) };
    const { ts, sig } = sign('POST', PATH, body);
    const res = await (await import('supertest')).default(app)
      .post(PATH)
      .set('x-billing-timestamp', ts)
      .set('x-billing-signature', sig)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ matched: false });
  });

  it('returns matched: true with deletedAt for a hash present in the ledger', async () => {
    const deletedAt = new Date('2026-01-15T00:00:00.000Z');
    mockFindDeletionLedger.mockResolvedValueOnce({ id: 'led-1', deleted_at: deletedAt });
    const app = buildApp();
    const body = { emailHash: 'b'.repeat(64) };
    const { ts, sig } = sign('POST', PATH, body);
    const res = await (await import('supertest')).default(app)
      .post(PATH)
      .set('x-billing-timestamp', ts)
      .set('x-billing-signature', sig)
      .send(body);
    expect(res.status).toBe(200);
    expect(res.body.matched).toBe(true);
    expect(res.body.deletedAt).toBe(deletedAt.toISOString());
  });

  it('rejects without valid HMAC headers (401)', async () => {
    const app = buildApp();
    const res = await (await import('supertest')).default(app)
      .post(PATH)
      .set('x-billing-timestamp', String(Date.now()))
      .set('x-billing-signature', 'deadbeef')
      .send({ emailHash: 'c'.repeat(64) });
    expect(res.status).toBe(401);
    expect(mockFindDeletionLedger).not.toHaveBeenCalled();
  });

  it('rejects request missing emailHash (400)', async () => {
    const app = buildApp();
    const { ts, sig } = sign('POST', PATH, {});
    const res = await (await import('supertest')).default(app)
      .post(PATH)
      .set('x-billing-timestamp', ts)
      .set('x-billing-signature', sig)
      .send({});
    expect(res.status).toBe(400);
  });
});
