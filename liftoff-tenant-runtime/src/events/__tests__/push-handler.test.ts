// HTTP-shaped tests for the Pub/Sub push handler. Exercises the full
// router (mounted at /internal/pubsub) via Supertest against an in-process
// Express app. Covers the contract documented in push-handler.ts:
//
//   204  → success, schema-invalid (DLQ-routed), unknown event-type
//   400  → malformed envelope, undecodable payload
//   401  → missing/invalid OIDC bearer
//   500  → transient handler error (Pub/Sub will redeliver)
//   "about to DLQ" log line carries deliveryAttempt + full event context
//
// Heavy modules (DB pool, lifecycle service, instruction compiler) are mocked
// so the test boots in milliseconds; we only care about the push surface +
// dispatchEvent's error classification.

import express from 'express';
import request from 'supertest';

const dispatchEventMock = jest.fn();

jest.mock('../subscriber', () => {
  const SUBSCRIBED_EVENTS = [
    'tenant-entitlement-updated',
    'tenant-suspended',
    'tenant-reactivated',
    'tenant-deployment-approved',
    'tenant-model-config-updated',
    'tenant-prompt-bundle-updated',
    'tenant-feature-flag-updated',
    'control-plane-events',
  ] as const;
  return {
    SUBSCRIBED_EVENTS,
    MAX_DELIVERY_ATTEMPTS: 10,
    dispatchEvent: (...args: unknown[]) => dispatchEventMock(...args),
    // subscriberInternals.handleEvent is the inner test seam used by
    // subscriber-dlq.test.ts; push-handler tests don't need it but the
    // module exports it, so we stub it here to prevent ReferenceErrors when
    // anything in this test file's imports references it transitively.
    subscriberInternals: { handleEvent: jest.fn() },
    // Push handler imports subscriberPool + UUID_REGEX for the over-attempt /
    // permanent-error dlq_messages write path; stub them out here so the mock
    // module satisfies push-handler's import shape.
    subscriberPool: { query: jest.fn().mockResolvedValue({ rows: [] }) },
    UUID_REGEX: /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  };
});

jest.mock('../../infrastructure/logging', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger, log: logger };
});

const verifyGoogleOidcTokenMock = jest.fn();
jest.mock('../../security/oidc-verifier', () => {
  return {
    extractBearerToken: (h: string | undefined) => {
      if (!h) return null;
      const m = h.trim().match(/^Bearer\s+(.+)$/i);
      return m ? m[1].trim() : null;
    },
    verifyGoogleOidcToken: (...args: unknown[]) => verifyGoogleOidcTokenMock(...args),
  };
});

import { buildPushHandlerRouter } from '../push-handler';
import { DlqRoutedError, EntityBusyError } from '../event-processor';
import { logger } from '../../infrastructure/logging';

const loggerMock = logger as unknown as { info: jest.Mock; warn: jest.Mock; error: jest.Mock; debug: jest.Mock };

const COORD_URL = 'https://coordinator-service-abc-uw.a.run.app';
const PUSH_SA = 'YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com';

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '10mb' }));
  app.use('/internal/pubsub', buildPushHandlerRouter());
  return app;
}

function envelope(payload: object | string, opts: { messageId?: string; deliveryAttempt?: number; subscription?: string } = {}) {
  const data = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    message: {
      data: Buffer.from(data).toString('base64'),
      messageId: opts.messageId ?? 'msg-1',
      publishTime: '2026-05-14T00:00:00.000Z',
      deliveryAttempt: opts.deliveryAttempt,
    },
    subscription: opts.subscription ?? 'projects/YOUR_CONTROL_PROJECT_STAGING/subscriptions/control-plane-events-dev-coordinator-push',
  };
}

const validEvent = {
  event_id: 'evt-1',
  event_type: 'tenant.entitlement.updated',
  entity_type: 'tenant',
  entity_id: 'tenant-1',
  tenant_id: 'tenant-1',
  entity_version: 1,
  payload: {},
};

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  dispatchEventMock.mockReset();
  verifyGoogleOidcTokenMock.mockReset();
  loggerMock.info.mockReset();
  loggerMock.warn.mockReset();
  loggerMock.error.mockReset();
  process.env.COORDINATOR_SERVICE_URL = COORD_URL;
  process.env.PUBSUB_PUSH_SA_EMAIL = PUSH_SA;
  // Default: OIDC succeeds with the expected SA email.
  verifyGoogleOidcTokenMock.mockResolvedValue({ ok: true, payload: { email: PUSH_SA, email_verified: true, iss: 'https://accounts.google.com' } });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('POST /internal/pubsub/:topic — happy path', () => {
  it('valid event → 204 and dispatchEvent is invoked', async () => {
    dispatchEventMock.mockResolvedValueOnce(undefined);
    const app = buildApp();

    const res = await request(app)
      .post('/internal/pubsub/control-plane-events')
      .set('Authorization', 'Bearer good-token')
      .send(envelope(validEvent, { deliveryAttempt: 1 }));

    expect(res.status).toBe(204);
    expect(dispatchEventMock).toHaveBeenCalledTimes(1);
    expect(dispatchEventMock).toHaveBeenCalledWith(
      validEvent,
      1,
      'control-plane-events-dev-coordinator-push',
    );
  });

  it('threads deliveryAttempt from envelope through to dispatchEvent', async () => {
    dispatchEventMock.mockResolvedValueOnce(undefined);
    const app = buildApp();

    await request(app)
      .post('/internal/pubsub/control-plane-events')
      .set('Authorization', 'Bearer good-token')
      .send(envelope(validEvent, { deliveryAttempt: 7 }));

    expect(dispatchEventMock).toHaveBeenCalledWith(validEvent, 7, expect.any(String));
  });

  it('defaults deliveryAttempt to 1 when envelope omits it', async () => {
    dispatchEventMock.mockResolvedValueOnce(undefined);
    const app = buildApp();

    await request(app)
      .post('/internal/pubsub/control-plane-events')
      .set('Authorization', 'Bearer good-token')
      .send(envelope(validEvent));

    expect(dispatchEventMock).toHaveBeenCalledWith(validEvent, 1, expect.any(String));
  });
});

describe('POST /internal/pubsub/:topic — DLQ + transient error contract', () => {
  it('schema-invalid (DlqRoutedError) → 204 (event preserved in dlq_messages by dispatchEvent)', async () => {
    dispatchEventMock.mockRejectedValueOnce(new DlqRoutedError('evt-bad'));
    const app = buildApp();

    const res = await request(app)
      .post('/internal/pubsub/control-plane-events')
      .set('Authorization', 'Bearer good-token')
      .send(envelope({ not: 'an event' }));

    expect(res.status).toBe(204);
    // Disposition log distinguishes DLQ-ack from regular ack.
    expect(loggerMock.info).toHaveBeenCalledWith(
      'Pub/Sub push: schema-invalid → DLQ table, acking',
      expect.objectContaining({ disposition: 'dlq_ack' }),
    );
  });

  it('transient handler error → 500 (Pub/Sub will redeliver)', async () => {
    dispatchEventMock.mockRejectedValueOnce(new Error('postgres unavailable'));
    const app = buildApp();

    const res = await request(app)
      .post('/internal/pubsub/control-plane-events')
      .set('Authorization', 'Bearer good-token')
      .send(envelope(validEvent));

    expect(res.status).toBe(500);
    // Phase 4.2 push-handler classification: unmatched errors fall through
    // classifyError's "transient" default branch, which sets error='transient'.
    expect(res.body).toEqual(
      expect.objectContaining({ error: 'transient', message: 'postgres unavailable' }),
    );
  });

  it('EntityBusyError → 500 with structured body so Pub/Sub redelivers', async () => {
    dispatchEventMock.mockRejectedValueOnce(new EntityBusyError('evt-1', 'agent-1'));
    const app = buildApp();

    const res = await request(app)
      .post('/internal/pubsub/control-plane-events')
      .set('Authorization', 'Bearer good-token')
      .send(envelope(validEvent));

    expect(res.status).toBe(500);
    expect(res.body).toEqual(
      expect.objectContaining({ error: 'entity_busy', event_id: 'evt-1', entity_id: 'agent-1' }),
    );
  });

  it('unknown event_type → 204 (default-case warn-and-ack inside dispatchEvent)', async () => {
    // Production behaviour: dispatchEvent's switch falls through to default
    // which logs a warn and returns. The push handler sees a successful
    // promise resolution and returns 204.
    dispatchEventMock.mockResolvedValueOnce(undefined);
    const app = buildApp();

    const res = await request(app)
      .post('/internal/pubsub/control-plane-events')
      .set('Authorization', 'Bearer good-token')
      .send(
        envelope({
          ...validEvent,
          event_type: 'tenant.totally.unknown',
        }),
      );

    expect(res.status).toBe(204);
  });

  it('"about to DLQ" log line carries deliveryAttempt threaded from the envelope', async () => {
    // Phase 4.2 push-handler classification: deliveryAttempt ≥ 8 triggers the
    // subscriber-side over-attempt cap → 204 + DLQ row. The behaviour we still
    // need to assert here is that dispatchEvent receives the correct
    // deliveryAttempt from the envelope so production logs are accurate.
    let observedDeliveryAttempt: number | undefined;
    dispatchEventMock.mockImplementationOnce(async (_e: unknown, attempt: number) => {
      observedDeliveryAttempt = attempt;
      throw new Error('boom');
    });
    const app = buildApp();

    const res = await request(app)
      .post('/internal/pubsub/control-plane-events')
      .set('Authorization', 'Bearer good-token')
      .send(envelope(validEvent, { deliveryAttempt: 9 }));

    expect(observedDeliveryAttempt).toBe(9);
    expect(res.status).toBe(204);
  });
});

describe('POST /internal/pubsub/:topic — envelope validation', () => {
  it('malformed envelope (no message field) → 400, dispatch not called', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/internal/pubsub/control-plane-events')
      .set('Authorization', 'Bearer good-token')
      .send({ wrong: 'shape' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({ error: 'malformed_envelope' }));
    expect(dispatchEventMock).not.toHaveBeenCalled();
  });

  it('envelope missing message.data → 400', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/internal/pubsub/control-plane-events')
      .set('Authorization', 'Bearer good-token')
      .send({ message: { messageId: 'm1' }, subscription: 'projects/x/subscriptions/y' });

    expect(res.status).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({ error: 'envelope_missing_data' }));
    expect(dispatchEventMock).not.toHaveBeenCalled();
  });

  it('payload that does not decode as JSON → 400 (no DLQ row, nothing to write)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/internal/pubsub/control-plane-events')
      .set('Authorization', 'Bearer good-token')
      .send({
        message: {
          // base64 of "not-json" — decodes fine but JSON.parse throws.
          data: Buffer.from('not-json').toString('base64'),
          messageId: 'm1',
          deliveryAttempt: 1,
        },
        subscription: 'projects/x/subscriptions/control-plane-events-dev-coordinator-push',
      });

    expect(res.status).toBe(400);
    expect(res.body).toEqual(expect.objectContaining({ error: 'payload_decode_failed' }));
    expect(dispatchEventMock).not.toHaveBeenCalled();
  });
});

describe('POST /internal/pubsub/:topic — OIDC enforcement', () => {
  it('missing bearer → 401, dispatch not called', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/internal/pubsub/control-plane-events')
      .send(envelope(validEvent));

    expect(res.status).toBe(401);
    expect(res.body).toEqual(expect.objectContaining({ error: 'missing_bearer_token' }));
    expect(verifyGoogleOidcTokenMock).not.toHaveBeenCalled();
    expect(dispatchEventMock).not.toHaveBeenCalled();
  });

  it('OIDC verification failure (bad signature, wrong audience, wrong email, expired) → 401', async () => {
    verifyGoogleOidcTokenMock.mockResolvedValueOnce({ ok: false, reason: 'oidc_email_not_allowed: spoofed@evil.com' });
    const app = buildApp();

    const res = await request(app)
      .post('/internal/pubsub/control-plane-events')
      .set('Authorization', 'Bearer some-token')
      .send(envelope(validEvent));

    expect(res.status).toBe(401);
    expect(res.body).toEqual(expect.objectContaining({ error: 'oidc_verification_failed' }));
    expect(dispatchEventMock).not.toHaveBeenCalled();
  });

  it('OIDC verifier called with audience and allowedEmails from process.env (COORDINATOR_SERVICE_URL, PUBSUB_PUSH_SA_EMAIL)', async () => {
    dispatchEventMock.mockResolvedValueOnce(undefined);
    const app = buildApp();

    await request(app)
      .post('/internal/pubsub/control-plane-events')
      .set('Authorization', 'Bearer good-token')
      .send(envelope(validEvent));

    expect(verifyGoogleOidcTokenMock).toHaveBeenCalledWith(
      'good-token',
      expect.objectContaining({ audience: COORD_URL, allowedEmails: [PUSH_SA] }),
    );
  });
});

describe('Router wiring', () => {
  it('mounts a route for every topic in SUBSCRIBED_EVENTS', async () => {
    dispatchEventMock.mockResolvedValue(undefined);
    const app = buildApp();
    const topics = [
      'tenant-entitlement-updated',
      'tenant-suspended',
      'tenant-reactivated',
      'tenant-deployment-approved',
      'tenant-model-config-updated',
      'tenant-prompt-bundle-updated',
      'tenant-feature-flag-updated',
      'control-plane-events',
    ];

    for (const topic of topics) {
      const res = await request(app)
        .post(`/internal/pubsub/${topic}`)
        .set('Authorization', 'Bearer good-token')
        .send(envelope(validEvent));
      expect(res.status).toBe(204);
    }
    expect(dispatchEventMock).toHaveBeenCalledTimes(topics.length);
  });

  it('unknown topic → 404 (default Express behaviour, no dispatch)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/internal/pubsub/totally-fake-topic')
      .set('Authorization', 'Bearer good-token')
      .send(envelope(validEvent));

    expect(res.status).toBe(404);
    expect(dispatchEventMock).not.toHaveBeenCalled();
  });
});
