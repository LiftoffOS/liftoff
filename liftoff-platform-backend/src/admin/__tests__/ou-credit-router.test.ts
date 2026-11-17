// Handing Operating Units back for work that failed.
//
// This route grants real compute on a human's discretion, so three things are
// worth pinning. The grant is always recorded with a reason and an actor. A
// mistyped ceiling is refused rather than spent. And a replayed request credits
// exactly once — that last one matters most, because a double credit is silent
// and nothing downstream would ever flag it.

import express from 'express';
import request from 'supertest';
import { ouCreditAdminRouter, MAX_OPERATOR_CREDIT_OUS } from '../ou-credit-router';
import { ingestEventWithBuckets } from '../../cost-attribution/repository';
import { logAdminAction } from '../middleware';
import { getPool } from '../../infrastructure/database';

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));
jest.mock('../middleware', () => ({
  logAdminAction: jest.fn(),
}));
jest.mock('../../cost-attribution/repository', () => ({
  ingestEventWithBuckets: jest.fn(),
}));
jest.mock('../../cost-attribution/ou-bucket-service', () => ({
  // 1 OU = $0.01 of raw compute, as migration 206 seeds it.
  getOuDefinitionRateUsd: jest.fn().mockResolvedValue(0.01),
}));

const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const TENANT = '11111111-1111-4111-8111-111111111111';
const ADMIN = { id: 'admin-1', email: 'ops@example.com' };

const mockIngest = ingestEventWithBuckets as jest.MockedFunction<typeof ingestEventWithBuckets>;
const mockAudit = logAdminAction as jest.MockedFunction<typeof logAdminAction>;

/** Stands in for adminAuthMiddleware, which is what sets adminAccount. */
function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { adminAccount?: typeof ADMIN }).adminAccount = ADMIN;
    (req as express.Request).ctx = { requestId: 'test', operation: 'test' };
    next();
  });
  app.use('/api/admin/accounts', ouCreditAdminRouter);
  return app;
}

function mockTenantLookup(rows: Array<{ id: string }>) {
  (getPool as jest.Mock).mockReturnValue({
    query: jest.fn().mockResolvedValue({ rows }),
    connect: jest.fn().mockResolvedValue({ release: jest.fn() }),
  });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTenantLookup([{ id: TENANT }]);
  mockAudit.mockResolvedValue({
    actionId: 'audit-1',
    action: 'billing.ou_credit.grant',
    actor: { accountId: ADMIN.id, email: ADMIN.email },
    timestamp: new Date().toISOString(),
  });
  mockIngest.mockResolvedValue(1);
});

const PATH = `/api/admin/accounts/${ACCOUNT}/ou-credit`;

describe('granting Operating Unit credit', () => {
  it('credits the units and records who granted them and why', async () => {
    const res = await request(buildApp())
      .post(PATH)
      .send({ operatingUnits: 800, reason: 'run produced nothing usable' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ accountId: ACCOUNT, operatingUnits: 800, credited: true });
    expect(res.body.audit.action).toBe('billing.ou_credit.grant');

    // Units convert to a NEGATIVE dollar amount at the definition rate, which is
    // what routes the event through applyOuRefund rather than a consumption.
    const [, , rawCostUsd, template] = mockIngest.mock.calls[0];
    expect(rawCostUsd).toBeCloseTo(-8, 10);
    expect(template).toMatchObject({
      tenantId: TENANT,
      eventType: 'credit',
      source: 'operator_credit',
      purpose: 'run produced nothing usable',
    });
  });

  // The property that matters most: a double credit is silent.
  it('credits once when the same idempotency key is replayed', async () => {
    mockIngest.mockResolvedValueOnce(1).mockResolvedValueOnce(0);
    const body = { operatingUnits: 800, reason: 'outage', idempotencyKey: 'incident-42' };

    const first = await request(buildApp()).post(PATH).send(body);
    const second = await request(buildApp()).post(PATH).send(body);

    expect(first.body.data.credited).toBe(true);
    expect(second.body.data.credited).toBe(false);
    // Both calls carry the SAME source id, which is what lets the boundary
    // recognise the replay before it touches the counter.
    expect(mockIngest.mock.calls[0][1]).toBe('incident-42');
    expect(mockIngest.mock.calls[1][1]).toBe('incident-42');
  });

  it('falls back to the audit id so an un-keyed grant is its own grant', async () => {
    await request(buildApp()).post(PATH).send({ operatingUnits: 10, reason: 'goodwill' });

    expect(mockIngest.mock.calls[0][1]).toBe('admin-credit/audit-1');
  });

  it('refuses a grant above the ceiling rather than spending it', async () => {
    const res = await request(buildApp())
      .post(PATH)
      .send({ operatingUnits: MAX_OPERATOR_CREDIT_OUS + 1, reason: 'typo' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('invalid_grant');
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('refuses a non-positive grant', async () => {
    for (const operatingUnits of [0, -800]) {
      const res = await request(buildApp()).post(PATH).send({ operatingUnits, reason: 'x' });
      expect(res.status).toBe(400);
    }
    expect(mockIngest).not.toHaveBeenCalled();
  });

  // The audit row is the only record of a discretionary grant of real compute.
  it('requires a reason', async () => {
    const res = await request(buildApp()).post(PATH).send({ operatingUnits: 800 });

    expect(res.status).toBe(400);
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('reports an account with no workspace rather than crediting nothing', async () => {
    mockTenantLookup([]);
    const res = await request(buildApp()).post(PATH).send({ operatingUnits: 800, reason: 'x' });

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('tenant_not_found');
    expect(mockIngest).not.toHaveBeenCalled();
  });

  it('surfaces a failure to credit instead of reporting success', async () => {
    mockIngest.mockRejectedValue(new Error('counter locked'));
    const res = await request(buildApp()).post(PATH).send({ operatingUnits: 800, reason: 'x' });

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('ou_credit_failed');
  });
});
