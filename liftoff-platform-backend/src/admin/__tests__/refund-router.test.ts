// Returning money for a subscription invoice.
//
// This router computes nothing — billing owns every amount — so what is worth
// pinning here is the boundary behaviour: that the act is recorded before the
// money moves, and that a policy REFUSAL reaches the operator as a refusal with
// its reason rather than as a generic failure they would retry blindly.

import express from 'express';
import request from 'supertest';
import { refundAdminRouter } from '../refund-router';
import { getBillingAdminClient } from '../../billing/billing-admin-client';
import { logAdminAction } from '../middleware';
import { getPool } from '../../infrastructure/database';

jest.mock('../../infrastructure/database', () => ({ getPool: jest.fn() }));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));
jest.mock('../middleware', () => ({ logAdminAction: jest.fn() }));
jest.mock('../../billing/billing-admin-client');

const ACCOUNT = '22222222-2222-4222-8222-222222222222';
const TENANT = '11111111-1111-4111-8111-111111111111';
const ADMIN = { id: 'admin-1', email: 'ops@example.com' };

const refundQuote = jest.fn();
const issueRefund = jest.fn();
const mockClient = getBillingAdminClient as jest.MockedFunction<typeof getBillingAdminClient>;
const mockAudit = logAdminAction as jest.MockedFunction<typeof logAdminAction>;

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as express.Request & { adminAccount?: typeof ADMIN }).adminAccount = ADMIN;
    (req as express.Request).ctx = { requestId: 'test', operation: 'test' };
    next();
  });
  app.use('/api/admin/accounts', refundAdminRouter);
  return app;
}

function mockTenant(rows: Array<{ id: string }>) {
  (getPool as jest.Mock).mockReturnValue({ query: jest.fn().mockResolvedValue({ rows }) });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockTenant([{ id: TENANT }]);
  mockClient.mockReturnValue({ refundQuote, issueRefund } as never);
  mockAudit.mockResolvedValue({
    actionId: 'audit-1',
    action: 'billing.refund.issue',
    actor: { accountId: ADMIN.id, email: ADMIN.email },
    timestamp: new Date().toISOString(),
  });
  refundQuote.mockResolvedValue({
    refundableCents: 120_000,
    refusal: null,
    monthsStarted: 4,
    monthlyListCents: 20_000,
    amountPaidCents: 200_000,
  });
  issueRefund.mockResolvedValue({
    creditNoteId: 'cn_1',
    refundedCents: 120_000,
    cancelledSubscriptionId: 'sub_1',
  });
});

const QUOTE = `/api/admin/accounts/${ACCOUNT}/refund-quote`;
const REFUND = `/api/admin/accounts/${ACCOUNT}/refunds`;
const BODY = {
  stripeInvoiceId: 'in_1',
  amountCents: 120_000,
  reason: 'annual cancelled at month four',
  idempotencyKey: 'refund-42',
};

describe('quoting a refund', () => {
  it('returns what billing computed, and writes no audit row', async () => {
    const res = await request(buildApp()).post(QUOTE).send({ stripeInvoiceId: 'in_1' });

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ refundableCents: 120_000, monthsStarted: 4 });
    // Asking is not an act.
    expect(mockAudit).not.toHaveBeenCalled();
  });

  it('reports an account with no workspace', async () => {
    mockTenant([]);
    const res = await request(buildApp()).post(QUOTE).send({ stripeInvoiceId: 'in_1' });
    expect(res.status).toBe(404);
  });
});

describe('issuing a refund', () => {
  it('records the act before the money moves, and returns the credit note', async () => {
    const res = await request(buildApp()).post(REFUND).send(BODY);

    expect(res.status).toBe(200);
    expect(res.body.data).toMatchObject({ creditNoteId: 'cn_1', cancelledSubscriptionId: 'sub_1' });
    expect(res.body.audit.action).toBe('billing.refund.issue');
    expect(mockAudit).toHaveBeenCalled();
    expect(issueRefund).toHaveBeenCalledWith({ tenantId: TENANT, ...BODY });
  });

  it('still records the attempt when the refund then fails', async () => {
    issueRefund.mockRejectedValue(new Error('stripe down'));
    const res = await request(buildApp()).post(REFUND).send(BODY);

    expect(res.status).toBe(502);
    expect(mockAudit).toHaveBeenCalled();
  });

  // A refusal is not a failure. An operator who gets a generic 502 retries; one
  // who is told the term is fully consumed stops.
  it('passes a policy refusal through as 409 with its reason', async () => {
    issueRefund.mockRejectedValue(
      Object.assign(new Error('refused'), { status: 409, body: '{"error":"term_fully_consumed"}' }),
    );
    const res = await request(buildApp()).post(REFUND).send(BODY);

    expect(res.status).toBe(409);
    expect(res.body.error).toBe('refund_refused');
    expect(res.body.detail).toContain('term_fully_consumed');
  });

  it('requires a reason and an idempotency key', async () => {
    for (const missing of ['reason', 'idempotencyKey'] as const) {
      const body: Record<string, unknown> = { ...BODY };
      delete body[missing];
      const res = await request(buildApp()).post(REFUND).send(body);
      expect(res.status).toBe(400);
    }
    expect(issueRefund).not.toHaveBeenCalled();
  });

  it('refuses a non-positive amount', async () => {
    const res = await request(buildApp()).post(REFUND).send({ ...BODY, amountCents: 0 });
    expect(res.status).toBe(400);
    expect(issueRefund).not.toHaveBeenCalled();
  });
});
