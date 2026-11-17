// Tests for the Composio webhook receiver — HMAC verification + payload
// dispatch. The crypto path is in-band (Node's built-in HMAC), so we don't
// mock it; we generate real signatures.

jest.mock('../events/publisher', () => ({
  publishEventWithExplicitId: jest.fn().mockResolvedValue(undefined),
}));
jest.mock('./connector-service-client', () => ({
  reportReconnectRequired: jest.fn(),
}));
jest.mock('../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import crypto from 'node:crypto';
import express from 'express';
import request from 'supertest';
import { composioWebhookRouter } from './composio-webhook-router';
import { publishEventWithExplicitId } from '../events/publisher';

const mockPublish = publishEventWithExplicitId as jest.MockedFunction<typeof publishEventWithExplicitId>;
import { reportReconnectRequired } from './connector-service-client';
const mockReport = reportReconnectRequired as jest.MockedFunction<typeof reportReconnectRequired>;

const SECRET = 'test-webhook-secret';

function makeApp() {
  const app = express();
  app.use(
    '/api/internal/composio-webhook',
    express.raw({ type: '*/*', limit: '1mb' }),
    composioWebhookRouter,
  );
  return app;
}

function signedHeaders(body: string, secret = SECRET, timestamp = Math.floor(Date.now() / 1000)) {
  const webhookId = 'msg_test_abc';
  const signedContent = `${webhookId}.${timestamp}.${body}`;
  const sig = crypto.createHmac('sha256', secret).update(signedContent).digest('base64');
  return {
    'webhook-id': webhookId,
    'webhook-timestamp': String(timestamp),
    'webhook-signature': `v1,${sig}`,
  };
}

function gmailTriggerPayload(overrides: Partial<{ tenantId: string; connectedAccountId: string; triggerId: string }> = {}) {
  const body = {
    id: 'evt_test_123',
    timestamp: new Date().toISOString(),
    type: 'composio.trigger.fired',
    metadata: {
      log_id: 'log_test_456',
      trigger_slug: 'GMAIL_NEW_GMAIL_MESSAGE',
      trigger_id: overrides.triggerId ?? 'trg_test_789',
      connected_account_id: overrides.connectedAccountId ?? 'ca_TEST_acct',
      auth_config_id: 'ac_TEST_cfg',
      user_id: overrides.tenantId ?? 'tenant-uuid-here',
    },
    data: {
      message_id: 'gmail-msg-id',
      from: 'sender@example.com',
      subject: 'Test',
    },
  };
  return JSON.stringify(body);
}

describe('composio-webhook-router', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    process.env.COMPOSIO_WEBHOOK_SECRET = SECRET;
  });

  describe('HMAC verification', () => {
    it('returns 400 when webhook headers are missing', async () => {
      const app = makeApp();
      const res = await request(app)
        .post('/api/internal/composio-webhook')
        .set('content-type', 'application/json')
        .send(gmailTriggerPayload());
      expect(res.status).toBe(400);
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('returns 401 when signature does not match', async () => {
      const body = gmailTriggerPayload();
      const headers = signedHeaders(body, 'wrong-secret');
      const app = makeApp();
      const res = await request(app)
        .post('/api/internal/composio-webhook')
        .set('content-type', 'application/json')
        .set(headers)
        .send(body);
      expect(res.status).toBe(401);
      expect(res.body.reason).toBe('signature_mismatch');
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('returns 401 when timestamp is outside the 5-min tolerance window', async () => {
      const body = gmailTriggerPayload();
      const oldTs = Math.floor(Date.now() / 1000) - 1000;
      const headers = signedHeaders(body, SECRET, oldTs);
      const app = makeApp();
      const res = await request(app)
        .post('/api/internal/composio-webhook')
        .set('content-type', 'application/json')
        .set(headers)
        .send(body);
      expect(res.status).toBe(401);
      expect(res.body.reason).toBe('timestamp_outside_tolerance');
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('accepts multi-signature headers (key rotation) when any v1 matches', async () => {
      const body = gmailTriggerPayload();
      const valid = signedHeaders(body)['webhook-signature'];
      const headers = signedHeaders(body);
      headers['webhook-signature'] = `v1,bogus-other-sig ${valid}`;
      const app = makeApp();
      const res = await request(app)
        .post('/api/internal/composio-webhook')
        .set('content-type', 'application/json')
        .set(headers)
        .send(body);
      expect(res.status).toBe(200);
      expect(mockPublish).toHaveBeenCalled();
    });

    it('returns 500 when COMPOSIO_WEBHOOK_SECRET env is unset', async () => {
      delete process.env.COMPOSIO_WEBHOOK_SECRET;
      const body = gmailTriggerPayload();
      const headers = signedHeaders(body);
      const app = makeApp();
      const res = await request(app)
        .post('/api/internal/composio-webhook')
        .set('content-type', 'application/json')
        .set(headers)
        .send(body);
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('server_misconfigured');
    });
  });

  describe('dispatch', () => {
    it('on valid Gmail trigger payload, publishes connector.composio_trigger_fired with the routing fields populated', async () => {
      const body = gmailTriggerPayload({
        tenantId: 'dd7d80bd-3b77-4677-817c-053fdb8668cd',
        connectedAccountId: 'ca_MTjQ55OS2di8',
      });
      const headers = signedHeaders(body);
      const app = makeApp();
      const res = await request(app)
        .post('/api/internal/composio-webhook')
        .set('content-type', 'application/json')
        .set(headers)
        .send(body);

      expect(res.status).toBe(200);
      expect(mockPublish).toHaveBeenCalledTimes(1);
      const call = mockPublish.mock.calls[0][0];
      expect(call.eventType).toBe('connector.composio_trigger_fired');
      expect(call.entityType).toBe('connector');
      expect(call.entityId).toBe('ca_MTjQ55OS2di8');
      expect(call.tenantId).toBe('dd7d80bd-3b77-4677-817c-053fdb8668cd');
      expect(call.payload).toMatchObject({
        composioConnectedAccountId: 'ca_MTjQ55OS2di8',
        triggerSlug: 'GMAIL_NEW_GMAIL_MESSAGE',
        data: expect.objectContaining({ message_id: 'gmail-msg-id', subject: 'Test' }),
      });
    });

    it('dedup-friendly eventId uses composio log_id + webhook id', async () => {
      const body = gmailTriggerPayload();
      const headers = signedHeaders(body);
      const app = makeApp();
      await request(app)
        .post('/api/internal/composio-webhook')
        .set('content-type', 'application/json')
        .set(headers)
        .send(body);
      const call = mockPublish.mock.calls[0][0];
      expect(call.eventId).toContain('log_test_456');
      expect(call.eventId).toContain('test_abc');
    });

    it('returns 200 + ignored when payload metadata is missing required routing fields', async () => {
      const body = JSON.stringify({
        id: 'evt_x',
        timestamp: '2026-06-09T00:00:00Z',
        type: 'composio.trigger.fired',
        metadata: { log_id: 'lg', trigger_slug: 'X' }, // missing user_id + connected_account_id
        data: {},
      });
      const headers = signedHeaders(body);
      const app = makeApp();
      const res = await request(app)
        .post('/api/internal/composio-webhook')
        .set('content-type', 'application/json')
        .set(headers)
        .send(body);
      expect(res.status).toBe(200);
      expect(res.body.ignored).toBe('unrecognized_payload_shape');
      expect(mockPublish).not.toHaveBeenCalled();
    });

    it('returns 500 when publish fails so Composio retries', async () => {
      mockPublish.mockRejectedValueOnce(new Error('pubsub 503'));
      const body = gmailTriggerPayload();
      const headers = signedHeaders(body);
      const app = makeApp();
      const res = await request(app)
        .post('/api/internal/composio-webhook')
        .set('content-type', 'application/json')
        .set(headers)
        .send(body);
      expect(res.status).toBe(500);
      expect(res.body.error).toBe('publish_failed');
    });
  });
});

// Composio publishes an account-expired event, and until now the receiver
// treated every verified payload as a trigger firing and dropped it. That was
// the only notice we get that a composio-managed connector has stopped
// working: those dispatch in-process inside tenant runtime and never reach
// connector-service, so nothing else observes the failure.
describe('connected-account expiry', () => {
  function expiredPayload(type: string, body: Record<string, unknown>) {
    return JSON.stringify({
      id: 'evt_exp_1',
      timestamp: new Date().toISOString(),
      type,
      ...body,
    });
  }

  it('flags the connector when an account expires', async () => {
    mockReport.mockResolvedValueOnce(1);
    const body = expiredPayload('composio_connected_account_expired', {
      metadata: { connected_account_id: 'ca_expired_1', user_id: 't1' },
      data: {},
    });

    const res = await request(makeApp())
      .post('/api/internal/composio-webhook')
      .set(signedHeaders(body))
      .set('content-type', 'application/json')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.handled).toBe('connected_account_expired');
    expect(mockReport).toHaveBeenCalledWith({
      composioConnectedAccountId: 'ca_expired_1',
      reason: 'composio_account_expired',
    });
    // An expiry is not a trigger firing; it must not reach agents as one.
    expect(mockPublish).not.toHaveBeenCalled();
  });

  // We have the documented event name but no verified sample of its body, so
  // the account id is read from `data` as well as `metadata`.
  it('reads the account id out of data when metadata does not carry it', async () => {
    mockReport.mockResolvedValueOnce(1);
    const body = expiredPayload('composio_connected_account_expired', {
      data: { connected_account_id: 'ca_expired_2' },
    });

    const res = await request(makeApp())
      .post('/api/internal/composio-webhook')
      .set(signedHeaders(body))
      .set('content-type', 'application/json')
      .send(body);

    expect(res.status).toBe(200);
    expect(mockReport).toHaveBeenCalledWith({
      composioConnectedAccountId: 'ca_expired_2',
      reason: 'composio_account_expired',
    });
  });

  // The type string already moved once across the V2/V3 split, and the cost of
  // missing a rename is another silent class of broken connector.
  it('still matches if Composio renames the event', async () => {
    mockReport.mockResolvedValueOnce(1);
    const body = expiredPayload('composio.connected_account.expire', {
      data: { connectedAccountId: 'ca_expired_3' },
    });

    const res = await request(makeApp())
      .post('/api/internal/composio-webhook')
      .set(signedHeaders(body))
      .set('content-type', 'application/json')
      .send(body);

    expect(res.status).toBe(200);
    expect(mockReport).toHaveBeenCalled();
  });

  // Composio retries on 5xx, and a retry cannot fix a status write that
  // failed, so a reporting failure must still ack.
  it('acks even when the report finds nothing to flag', async () => {
    mockReport.mockResolvedValueOnce(0);
    const body = expiredPayload('composio_connected_account_expired', {
      metadata: { connected_account_id: 'ca_unknown' },
    });

    const res = await request(makeApp())
      .post('/api/internal/composio-webhook')
      .set(signedHeaders(body))
      .set('content-type', 'application/json')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0);
  });

  it('acks and reports nothing when the payload names no account', async () => {
    const body = expiredPayload('composio_connected_account_expired', { data: {} });

    const res = await request(makeApp())
      .post('/api/internal/composio-webhook')
      .set(signedHeaders(body))
      .set('content-type', 'application/json')
      .send(body);

    expect(res.status).toBe(200);
    expect(res.body.ignored).toBe('no_connected_account_id');
    expect(mockReport).not.toHaveBeenCalled();
  });
});
