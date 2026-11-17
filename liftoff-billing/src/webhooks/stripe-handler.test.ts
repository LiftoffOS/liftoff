import { describe, it, expect, jest, beforeEach } from '@jest/globals';
import Fastify, { type FastifyInstance } from 'fastify';
import Stripe from 'stripe';
import { createHmac } from 'node:crypto';
import { registerStripeWebhook } from './stripe-handler.js';

/* eslint-disable @typescript-eslint/no-explicit-any */
const mockFn = (): any => (jest.fn as any)();
/* eslint-enable @typescript-eslint/no-explicit-any */

function makeMockPool() {
  const rows: Record<string, unknown>[] = [];
  const outbox: Record<string, unknown>[] = [];
  const client = {
    query: mockFn().mockImplementation(async (sql: string, values?: unknown[]) => {
      if (/BEGIN|COMMIT|ROLLBACK/.test(sql)) return { rows: [] };
      if (/INSERT INTO stripe_webhook_events/.test(sql)) {
        const stripeEventId = (values as string[])[0];
        if (rows.some((r) => r.stripe_event_id === stripeEventId)) {
          return { rows: [] }; // ON CONFLICT DO NOTHING
        }
        rows.push({ stripe_event_id: stripeEventId });
        return { rows: [{ id: 'row-' + rows.length }] };
      }
      if (/INSERT INTO outbox_events/.test(sql)) {
        outbox.push({ args: values });
        return { rows: [] };
      }
      return { rows: [] };
    }),
    release: mockFn(),
  };
  return {
    pool: { connect: mockFn().mockImplementation(async () => client) },
    rows,
    outbox,
    client,
  };
}

function signPayload(secret: string, rawBody: string, t?: number): string {
  const timestamp = t ?? Math.floor(Date.now() / 1000);
  const signed = `${timestamp}.${rawBody}`;
  const v1 = createHmac('sha256', secret).update(signed).digest('hex');
  return `t=${timestamp},v1=${v1}`;
}

function buildApp(mock: ReturnType<typeof makeMockPool>, secrets: string[]) {
  const app = Fastify({ logger: false });
  const stripe = new Stripe('sk_test_dummy', { apiVersion: '2024-06-20' as Stripe.LatestApiVersion });
  registerStripeWebhook(app, {
    pool: mock.pool as never,
    stripe,
    webhookSecrets: secrets,
    toleranceSeconds: 300,
    log: { info: mockFn(), warn: mockFn(), error: mockFn() },
  });
  return app;
}

describe('POST /stripe/webhook', () => {
  let app: FastifyInstance;
  afterEach(async () => { if (app) await app.close(); });

  const event = {
    id: 'evt_test_1',
    type: 'invoice.finalized',
    created: 1_700_000_000,
    livemode: false,
    api_version: '2024-06-20',
    data: { object: { metadata: { tenant_id: '11111111-1111-1111-1111-111111111111' } } },
  };
  const rawBody = JSON.stringify(event);
  const secret = 'whsec_testsecret';

  it('200s on valid signature + writes webhook row + outbox row', async () => {
    const mock = makeMockPool();
    app = buildApp(mock, [secret]);
    const res = await app.inject({
      method: 'POST',
      url: '/stripe/webhook',
      headers: { 'stripe-signature': signPayload(secret, rawBody), 'content-type': 'application/json' },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(200);
    expect(mock.rows).toHaveLength(1);
    expect(mock.outbox).toHaveLength(1);
  });

  it('400s on invalid signature', async () => {
    const mock = makeMockPool();
    app = buildApp(mock, [secret]);
    const res = await app.inject({
      method: 'POST',
      url: '/stripe/webhook',
      headers: { 'stripe-signature': signPayload('wrong_secret', rawBody), 'content-type': 'application/json' },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(400);
    expect(mock.rows).toHaveLength(0);
  });

  it('rejects events older than tolerance window', async () => {
    const mock = makeMockPool();
    app = buildApp(mock, [secret]);
    const oldTs = Math.floor(Date.now() / 1000) - 600; // 10 minutes ago, > 300s tolerance
    const res = await app.inject({
      method: 'POST',
      url: '/stripe/webhook',
      headers: { 'stripe-signature': signPayload(secret, rawBody, oldTs), 'content-type': 'application/json' },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(400);
  });

  it('accepts previous secret during rotation window', async () => {
    const prevSecret = 'whsec_previous';
    const mock = makeMockPool();
    app = buildApp(mock, [secret, prevSecret]);
    const res = await app.inject({
      method: 'POST',
      url: '/stripe/webhook',
      headers: { 'stripe-signature': signPayload(prevSecret, rawBody), 'content-type': 'application/json' },
      payload: rawBody,
    });
    expect(res.statusCode).toBe(200);
  });

  it('idempotent on duplicate stripe_event_id', async () => {
    const mock = makeMockPool();
    app = buildApp(mock, [secret]);
    const headers = { 'stripe-signature': signPayload(secret, rawBody), 'content-type': 'application/json' };
    await app.inject({ method: 'POST', url: '/stripe/webhook', headers, payload: rawBody });
    const res = await app.inject({ method: 'POST', url: '/stripe/webhook', headers, payload: rawBody });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.duplicate).toBe(true);
    expect(mock.rows).toHaveLength(1);
    expect(mock.outbox).toHaveLength(1);
  });
});
