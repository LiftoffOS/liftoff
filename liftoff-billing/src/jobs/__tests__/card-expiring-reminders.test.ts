// Daily Cloud Scheduler job — finds default payment methods (cards) that
// will expire in 30 days and fires the card-expiring reminder email via PB.
// Dedupe via INSERT ... ON CONFLICT into card_expiring_reminders_sent so
// re-invocation in the same day is a no-op.

import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import type { Pool } from 'pg';

import { registerCardExpiringRemindersRouter } from '../card-expiring-reminders.js';
import type { PlatformBackendClient } from '../../infrastructure/platform-backend-client.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockFn = (): any => (jest.fn as any)();
/* eslint-enable @typescript-eslint/no-explicit-any */

const TOKEN = 'test-billing-service-token';

interface QueryResponse {
  rows: unknown[];
  rowCount?: number;
}

function mockPoolSequential(responses: QueryResponse[]): Pool {
  let i = 0;
  return {
    query: mockFn().mockImplementation(() => {
      const r = responses[i] ?? { rows: [], rowCount: 0 };
      i++;
      return Promise.resolve({ rows: r.rows, rowCount: r.rowCount ?? r.rows.length });
    }),
  } as unknown as Pool;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mockPb(): { client: PlatformBackendClient; cardExpiring: any } {
  const cardExpiring = mockFn().mockResolvedValue(undefined);
  return {
    client: { cardExpiring } as unknown as PlatformBackendClient,
    cardExpiring,
  };
}
/* eslint-enable @typescript-eslint/no-explicit-any */

async function buildApp(args: { pool: Pool; pbClient: PlatformBackendClient }): Promise<FastifyInstance> {
  const app = Fastify({ logger: false });
  registerCardExpiringRemindersRouter(app, {
    pool: args.pool,
    pbClient: args.pbClient,
    billingServiceToken: TOKEN,
  });
  await app.ready();
  return app;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe('POST /api/internal/jobs/card-expiring-reminders', () => {
  it('401 without X-Service-Auth', async () => {
    const app = await buildApp({ pool: mockPoolSequential([]), pbClient: mockPb().client });
    const res = await app.inject({ method: 'POST', url: '/api/internal/jobs/card-expiring-reminders' });
    expect(res.statusCode).toBe(401);
  });

  it('401 with wrong X-Service-Auth value', async () => {
    const app = await buildApp({ pool: mockPoolSequential([]), pbClient: mockPb().client });
    const res = await app.inject({
      method: 'POST',
      url: '/api/internal/jobs/card-expiring-reminders',
      headers: { 'x-service-auth': 'wrong' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('returns zero counts when no cards expiring this month', async () => {
    const pb = mockPb();
    const app = await buildApp({
      pool: mockPoolSequential([{ rows: [], rowCount: 0 }]),
      pbClient: pb.client,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/internal/jobs/card-expiring-reminders',
      headers: { 'x-service-auth': TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ processed: 0, sent: 0, skipped: 0, failed: 0 });
    expect(pb.cardExpiring).not.toHaveBeenCalled();
  });

  it('fires pbClient.cardExpiring for each new dedupe-row + counts sent', async () => {
    const pb = mockPb();
    const app = await buildApp({
      pool: mockPoolSequential([
        { rows: [
          { tenant_id: 't1', brand: 'visa', last4: '4242', exp_month: 6, exp_year: 2026, stripe_customer_id: 'cus_a' },
          { tenant_id: 't2', brand: 'mastercard', last4: '0001', exp_month: 6, exp_year: 2026, stripe_customer_id: 'cus_b' },
        ] },
        { rows: [{ tenant_id: 't1' }], rowCount: 1 },                // INSERT dedupe t1 won
        { rows: [{ tenant_id: 't2' }], rowCount: 1 },                // INSERT dedupe t2 won
      ]),
      pbClient: pb.client,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/internal/jobs/card-expiring-reminders',
      headers: { 'x-service-auth': TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ processed: 2, sent: 2, skipped: 0, failed: 0 });
    expect(pb.cardExpiring).toHaveBeenCalledTimes(2);
    expect(pb.cardExpiring.mock.calls[0]).toEqual([
      'cus_a',
      { cardBrand: 'visa', cardLast4: '4242', cardExpMonth: '06', cardExpYear: '2026' },
    ]);
    expect(pb.cardExpiring.mock.calls[1]).toEqual([
      'cus_b',
      { cardBrand: 'mastercard', cardLast4: '0001', cardExpMonth: '06', cardExpYear: '2026' },
    ]);
  });

  it('skips dedupe-row collisions (rowCount=0)', async () => {
    const pb = mockPb();
    const app = await buildApp({
      pool: mockPoolSequential([
        { rows: [
          { tenant_id: 't1', brand: 'visa', last4: '4242', exp_month: 6, exp_year: 2026, stripe_customer_id: 'cus_a' },
        ] },
        { rows: [], rowCount: 0 },                                   // dedupe already exists
      ]),
      pbClient: pb.client,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/internal/jobs/card-expiring-reminders',
      headers: { 'x-service-auth': TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ processed: 1, sent: 0, skipped: 1, failed: 0 });
    expect(pb.cardExpiring).not.toHaveBeenCalled();
  });

  it('counts pbClient failures and retains dedupe row to avoid spam', async () => {
    const pb = mockPb();
    pb.cardExpiring.mockRejectedValueOnce(new Error('PB down'));
    const app = await buildApp({
      pool: mockPoolSequential([
        { rows: [
          { tenant_id: 't1', brand: 'visa', last4: '4242', exp_month: 6, exp_year: 2026, stripe_customer_id: 'cus_a' },
        ] },
        { rows: [{ tenant_id: 't1' }], rowCount: 1 },
      ]),
      pbClient: pb.client,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/internal/jobs/card-expiring-reminders',
      headers: { 'x-service-auth': TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ processed: 1, sent: 0, skipped: 0, failed: 1 });
  });

  it('skips rows that have no stripe_customer_id mapping', async () => {
    const pb = mockPb();
    const app = await buildApp({
      pool: mockPoolSequential([
        { rows: [
          { tenant_id: 't1', brand: 'visa', last4: '4242', exp_month: 6, exp_year: 2026, stripe_customer_id: null },
        ] },
        { rows: [{ tenant_id: 't1' }], rowCount: 1 },                // dedupe wrote
      ]),
      pbClient: pb.client,
    });
    const res = await app.inject({
      method: 'POST',
      url: '/api/internal/jobs/card-expiring-reminders',
      headers: { 'x-service-auth': TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ processed: 1, sent: 0, skipped: 0, failed: 0 });
    expect(pb.cardExpiring).not.toHaveBeenCalled();
  });
});
