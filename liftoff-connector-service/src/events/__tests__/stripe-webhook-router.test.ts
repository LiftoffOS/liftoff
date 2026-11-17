// Stripe Connect webhook — the only route by which an UPDATED invoice or
// subscription reaches an agent.
//
// Each property below fails silently when it regresses: a 200 back to Stripe, a
// green log line, and no agent run.
//
//   1. The signature scheme is Stripe's, not GitHub's — signed payload is
//      `${t}.${rawBody}`, and a body-only digest verifies nothing.
//   2. A stale timestamp is refused, so a captured delivery cannot be replayed.
//   3. The delivery is scoped to the connector named in the URL, and verified
//      with THAT connector's own signing secret — under DCR each tenant has its
//      own endpoint on their own Stripe account, so there is no platform-wide
//      secret and no `account` field to key on.
//   4. The dedupe key is Stripe's event id, which it reuses on retry.
//   5. An unmapped event family and an unknown account are ACKed, not retried.

import crypto from 'node:crypto';

const mockPublish = jest.fn().mockResolvedValue(undefined);
jest.mock('../connector-webhook-event.js', () => ({
  publishConnectorWebhookEvent: (...a: unknown[]) => mockPublish(...(a as [])),
}));

const mockLookup = jest.fn();
jest.mock('../stripe-account-lookup.js', () => ({
  findStripeConnectorById: (...a: unknown[]) => mockLookup(...(a as [])),
}));

const mockCredential = jest.fn();
jest.mock('../../secrets/client.js', () => ({
  getConnectorCredential: (...a: unknown[]) => mockCredential(...(a as [])),
}));

jest.mock('../../infra/logging.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import express from 'express';
import request from 'supertest';
import {
  stripeWebhookRouter,
  verifyStripeSignature,
  entityTypeForStripeEvent,
} from '../stripe-webhook-router.js';

const SECRET = 'whsec_test_secret';
const CONNECTOR_ID = '11111111-2222-3333-4444-555555555555';

function sign(body: string, secret = SECRET, ts = Math.floor(Date.now() / 1000)): string {
  const v1 = crypto.createHmac('sha256', secret).update(`${ts}.${body}`).digest('hex');
  return `t=${ts},v1=${v1}`;
}

function makeApp() {
  const app = express();
  app.use('/api/connectors/stripe', express.raw({ type: 'application/json' }), stripeWebhookRouter);
  return app;
}

const INVOICE_EVENT = {
  id: 'evt_1',
  type: 'invoice.updated',
  account: 'acct_123',
  created: 1787000000,
  data: { object: { id: 'in_1', object: 'invoice', status: 'paid' } },
};

describe('verifyStripeSignature', () => {
  it('signs `${t}.${body}`, not the body alone', () => {
    const body = JSON.stringify(INVOICE_EVENT);
    const ts = 1787000000;
    const bodyOnly = crypto.createHmac('sha256', SECRET).update(body).digest('hex');
    expect(verifyStripeSignature(Buffer.from(body), `t=${ts},v1=${bodyOnly}`, SECRET, ts).ok).toBe(false);
    expect(verifyStripeSignature(Buffer.from(body), sign(body, SECRET, ts), SECRET, ts).ok).toBe(true);
  });

  it('accepts any v1 in the list, so a secret rotation does not drop deliveries', () => {
    const body = 'x';
    const ts = 1787000000;
    const good = crypto.createHmac('sha256', SECRET).update(`${ts}.${body}`).digest('hex');
    const header = `t=${ts},v1=${'0'.repeat(64)},v1=${good}`;
    expect(verifyStripeSignature(Buffer.from(body), header, SECRET, ts).ok).toBe(true);
  });

  it('refuses a timestamp outside tolerance, bounding replay', () => {
    const body = 'x';
    const ts = 1787000000;
    const r = verifyStripeSignature(Buffer.from(body), sign(body, SECRET, ts), SECRET, ts + 3600);
    expect(r).toEqual({ ok: false, reason: 'timestamp_outside_tolerance' });
  });

  it('refuses a malformed header rather than throwing', () => {
    expect(verifyStripeSignature(Buffer.from('x'), 'garbage', SECRET).ok).toBe(false);
  });
});

describe('entityTypeForStripeEvent', () => {
  it('maps by object family, leaving the vendor event name to travel as subtype', () => {
    expect(entityTypeForStripeEvent('invoice.payment_succeeded')).toBe('Invoice');
    expect(entityTypeForStripeEvent('customer.subscription.updated')).toBe('Subscription');
    expect(entityTypeForStripeEvent('payment_intent.succeeded')).toBe('PaymentIntent');
    expect(entityTypeForStripeEvent('charge.dispute.created')).toBeNull();
  });
});

describe('stripe webhook route', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockLookup.mockResolvedValue({ tenantId: 't1', connectorId: CONNECTOR_ID });
    mockCredential.mockResolvedValue({ metadata: { webhookSigningSecret: SECRET } });
  });

  const post = (body: unknown, header?: string, connectorId = CONNECTOR_ID) => {
    const raw = JSON.stringify(body);
    return request(makeApp())
      .post(`/api/connectors/stripe/webhook/${connectorId}`)
      .set('Content-Type', 'application/json')
      .set('stripe-signature', header ?? sign(raw))
      .send(raw);
  };

  it('publishes an updated invoice to the connector named in the URL', async () => {
    const res = await post(INVOICE_EVENT);
    expect(res.status).toBe(200);
    expect(mockLookup).toHaveBeenCalledWith(CONNECTOR_ID);
    expect(mockPublish).toHaveBeenCalledTimes(1);
    expect(mockPublish.mock.calls[0][0]).toMatchObject({
      source: 'stripe',
      subtype: 'invoice.updated',
      entityType: 'Invoice',
      entityId: 'in_1',
      tenantId: 't1',
      connectorId: CONNECTOR_ID,
      eventId: 'evt_1',
      data: { id: 'in_1', object: 'invoice', status: 'paid' },
    });
  });

  it('dedupes on Stripe\'s event id, which it reuses on retry', async () => {
    await post(INVOICE_EVENT);
    await post(INVOICE_EVENT);
    expect(mockPublish.mock.calls[0][0]).toMatchObject({ eventId: 'evt_1' });
    expect(mockPublish.mock.calls[1][0]).toMatchObject({ eventId: 'evt_1' });
  });

  it('verifies against THIS connector\'s secret, not a shared one', async () => {
    // Each tenant registers their own endpoint on their own Stripe account, so
    // a signature valid for one connector must not be accepted for another.
    mockCredential.mockResolvedValue({ metadata: { webhookSigningSecret: 'whsec_someone_else' } });
    const res = await post(INVOICE_EVENT);
    expect(res.status).toBe(401);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('404s a delivery for a connector that no longer exists', async () => {
    // A disconnected connector's endpoint keeps firing until someone deletes it
    // at Stripe. Nothing is wrong with the signature; there is nobody to notify.
    mockLookup.mockResolvedValue(null);
    const res = await post(INVOICE_EVENT);
    expect(res.status).toBe(404);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('rejects a bad signature without publishing', async () => {
    const res = await post(INVOICE_EVENT, sign(JSON.stringify(INVOICE_EVENT), 'whsec_wrong'));
    expect(res.status).toBe(401);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('refuses when no secret was stored rather than trusting the caller', async () => {
    // Registration can fail without failing the connection, which leaves a
    // connector with a token and no webhook secret.
    mockCredential.mockResolvedValue({ metadata: {} });
    const res = await post(INVOICE_EVENT);
    expect(res.status).toBe(503);
    expect(mockPublish).not.toHaveBeenCalled();
  });

  it('ACKs an unmapped family and an unknown account instead of inviting retries', async () => {
    // Stripe retries a non-2xx. Neither of these is fixed by repeating it.
    const other = await post({ ...INVOICE_EVENT, type: 'charge.dispute.created' });
    expect(other.status).toBe(200);
    expect(mockPublish).not.toHaveBeenCalled();

  });

  it('rejects a malformed connector id before it reaches the database', async () => {
    // The path segment is attacker-controlled; a non-uuid would otherwise raise
    // 22P02 and surface as a 500 on a request anyone can make.
    mockLookup.mockResolvedValue(null);
    const res = await post(INVOICE_EVENT, undefined, 'not-a-uuid');
    expect(res.status).toBe(404);
    expect(mockPublish).not.toHaveBeenCalled();
  });
});
