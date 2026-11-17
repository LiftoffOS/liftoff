// SE-002: Duplicate webhook handler removed — HARD GATE
//
// Verifies that platform-backend has NO Stripe webhook route. All webhook
// processing is handled exclusively by liftoff-billing.
// Two live handlers processing the same events would cause double-suspension,
// double-entitlement syncs, and idempotency breaks.

import express from 'express';
import request from 'supertest';

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn().mockReturnValue({
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
  }),
}));

// Import the subscriptions router — the former home of the duplicate handler
import { subscriptionsRouter } from '../../subscriptions/router';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/billing', subscriptionsRouter);
  return app;
}

describe('SE-002 — no Stripe webhook route in platform-backend', () => {
  it('POST /api/billing/webhook returns 404', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/api/billing/webhook')
      .set('stripe-signature', 'fake-sig')
      .send({ type: 'invoice.payment_succeeded' });

    // Must NOT be 200 — any handler responding 200 means a duplicate is active
    expect(res.status).toBe(404);
  });

  it('POST /webhook returns 404', async () => {
    const app = express();
    app.use(express.json());
    app.use('/', subscriptionsRouter);

    const res = await request(app)
      .post('/webhook')
      .set('stripe-signature', 'fake-sig')
      .send({ type: 'customer.subscription.updated' });

    expect(res.status).toBe(404);
  });

  it('subscriptions router exports no route matching /webhook', () => {
    // Inspect the router's stack to confirm no webhook handler is registered.
    // This is a belt-and-suspenders check: even if a future developer adds
    // a catch-all, this assertion will catch any route containing "webhook".
    const stack: Array<{ route?: { path?: string } }> = (subscriptionsRouter as unknown as { stack: Array<{ route?: { path?: string } }> }).stack;
    const webhookRoutes = stack
      .filter(layer => layer.route?.path?.toString().includes('webhook'))
      .map(layer => layer.route?.path);

    expect(webhookRoutes).toHaveLength(0);
  });
});
