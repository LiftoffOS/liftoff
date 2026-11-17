// Push-handler error classification tests. Verifies the catch-block branches
// added in Phase 4.2 (transient vs permanent, over-attempt cap, idempotent
// dlq_messages ON CONFLICT).

import express from 'express';
import request from 'supertest';

const dispatchEventMock = jest.fn();
const subscriberPoolQueryMock = jest.fn();

jest.mock('../subscriber', () => {
  const SUBSCRIBED_EVENTS = ['control-plane-events'] as const;
  return {
    SUBSCRIBED_EVENTS,
    MAX_DELIVERY_ATTEMPTS: 10,
    dispatchEvent: (...args: unknown[]) => dispatchEventMock(...args),
    subscriberInternals: { handleEvent: jest.fn() },
    subscriberPool: { query: subscriberPoolQueryMock },
    UUID_REGEX: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  };
});

jest.mock('../../infrastructure/logging', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger, log: logger };
});

const verifyGoogleOidcTokenMock = jest.fn();
jest.mock('../../security/oidc-verifier', () => ({
  extractBearerToken: (h: string | undefined) => {
    if (!h) return null;
    const m = h.trim().match(/^Bearer\s+(.+)$/i);
    return m ? m[1].trim() : null;
  },
  verifyGoogleOidcToken: (...args: unknown[]) => verifyGoogleOidcTokenMock(...args),
}));

import { buildPushHandlerRouter } from '../push-handler';
import { DlqRoutedError, EntityBusyError } from '../event-processor';

const COORD_URL = 'https://coordinator-service-abc-uw.a.run.app';
const PUSH_SA = 'YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com';
const TENANT = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/internal/pubsub', buildPushHandlerRouter());
  return app;
}

function envelope(payload: object, opts: { messageId?: string; deliveryAttempt?: number } = {}) {
  return {
    message: {
      data: Buffer.from(JSON.stringify(payload)).toString('base64'),
      messageId: opts.messageId ?? 'msg-1',
      publishTime: '2026-05-31T00:00:00Z',
      deliveryAttempt: opts.deliveryAttempt ?? 1,
    },
    subscription: 'projects/p/subscriptions/control-plane-events-dev-coordinator-push',
  };
}

beforeEach(() => {
  dispatchEventMock.mockReset();
  subscriberPoolQueryMock.mockReset();
  subscriberPoolQueryMock.mockResolvedValue({ rows: [] });
  verifyGoogleOidcTokenMock.mockReset();
  verifyGoogleOidcTokenMock.mockResolvedValue({ ok: true });
  process.env.COORDINATOR_SERVICE_URL = COORD_URL;
  process.env.PUBSUB_PUSH_SA_EMAIL = PUSH_SA;
});

const validEvent = {
  event_id: '97ad66e5-25d5-4bf1-aef0-342def728d7b',
  event_type: 'tenant.internal_agent.created',
  entity_type: 'internal_agent',
  entity_id: 'e8af341f-4d82-43c8-ba7b-6ca64bc8d983',
  tenant_id: TENANT,
  payload: {},
};

it('EntityBusyError → 500', async () => {
  dispatchEventMock.mockRejectedValue(new EntityBusyError('busy', 'e8af341f', '97ad66e5'));
  const r = await request(buildApp())
    .post('/internal/pubsub/control-plane-events')
    .set('Authorization', 'Bearer tok')
    .send(envelope(validEvent));
  expect(r.status).toBe(500);
  expect(r.body.error).toBe('entity_busy');
  expect(subscriberPoolQueryMock).not.toHaveBeenCalled();
});

it('FK violation → 204 + permanent dlq write', async () => {
  dispatchEventMock.mockRejectedValue(new Error('insert or update on table violates foreign key constraint'));
  const r = await request(buildApp())
    .post('/internal/pubsub/control-plane-events')
    .set('Authorization', 'Bearer tok')
    .send(envelope(validEvent));
  expect(r.status).toBe(204);
  expect(subscriberPoolQueryMock).toHaveBeenCalledTimes(1);
  const [, params] = subscriberPoolQueryMock.mock.calls[0];
  expect(params[5]).toMatch(/^\[permanent\]/); // error column starts with [permanent]
  expect(params[3]).toBe(TENANT);              // tenant_id
});

it('ETIMEDOUT → 500 transient, no DLQ write', async () => {
  dispatchEventMock.mockRejectedValue(new Error('connect ETIMEDOUT 1.2.3.4:5432'));
  const r = await request(buildApp())
    .post('/internal/pubsub/control-plane-events')
    .set('Authorization', 'Bearer tok')
    .send(envelope(validEvent));
  expect(r.status).toBe(500);
  expect(r.body.error).toBe('transient');
  expect(subscriberPoolQueryMock).not.toHaveBeenCalled();
});

it('over-attempt cap (deliveryAttempt=9, any error) → 204 + over-attempt dlq write', async () => {
  dispatchEventMock.mockRejectedValue(new Error('something flaky'));
  const r = await request(buildApp())
    .post('/internal/pubsub/control-plane-events')
    .set('Authorization', 'Bearer tok')
    .send(envelope(validEvent, { deliveryAttempt: 9 }));
  expect(r.status).toBe(204);
  expect(subscriberPoolQueryMock).toHaveBeenCalledTimes(1);
  const [, params] = subscriberPoolQueryMock.mock.calls[0];
  expect(params[5]).toMatch(/^\[over-attempt\]/);
});

it('DlqRoutedError → 204, no extra DLQ write (dispatchEvent already wrote it)', async () => {
  dispatchEventMock.mockRejectedValue(new DlqRoutedError('routed'));
  const r = await request(buildApp())
    .post('/internal/pubsub/control-plane-events')
    .set('Authorization', 'Bearer tok')
    .send(envelope(validEvent));
  expect(r.status).toBe(204);
  expect(subscriberPoolQueryMock).not.toHaveBeenCalled();
});

it('non-uuid tenant_id falls back to all-zeros UUID', async () => {
  dispatchEventMock.mockRejectedValue(new Error('foreign key constraint'));
  const r = await request(buildApp())
    .post('/internal/pubsub/control-plane-events')
    .set('Authorization', 'Bearer tok')
    .send(envelope({ ...validEvent, tenant_id: 'not-a-uuid' }));
  expect(r.status).toBe(204);
  const [, params] = subscriberPoolQueryMock.mock.calls[0];
  expect(params[3]).toBe('00000000-0000-0000-0000-000000000000');
});
