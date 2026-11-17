// Integration-style test for the push handler against the REAL dispatchEvent
// in subscriber.ts. push-handler.test.ts mocks '../subscriber' wholesale to
// keep the unit tests fast; here we wire the real dispatch pipeline so we can
// verify the contract bullet that the unit test can't observe:
//
//   "schema-invalid → 204 + dlq_messages row"
//
// Strategy: mock only the DB pool (capture queries), the logger, and the
// downstream-handler dependency graph. validateEventSchema and dispatchEvent
// run for real; the malformed event traverses dispatchEvent's validator path,
// hits the INSERT INTO dlq_messages, throws DlqRoutedError, and the push
// handler translates that to 204.

import express from 'express';
import request from 'supertest';

type QueryRecord = { sql: string; params?: unknown[] };
const queries: QueryRecord[] = [];

jest.mock('../../infrastructure/database', () => {
  const sharedPool = {
    query: jest.fn(async (sql: string, params?: unknown[]) => {
      queries.push({ sql, params });
      return { rows: [] };
    }),
    connect: jest.fn(async () => ({
      query: jest.fn(async (sql: string, params?: unknown[]) => {
        queries.push({ sql, params });
        return { rows: [] };
      }),
      release: jest.fn(),
    })),
  };
  return {
    subscriberPool: sharedPool,
    getPoolForService: () => sharedPool,
  };
});

jest.mock('../../infrastructure/logging', () => {
  const logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
  return { logger, log: logger };
});

jest.mock('../../instruction-compiler/internal-agent-instruction-service', () => ({
  internalAgentInstructionService: {
    createAndActivateForInternalAgent: jest.fn(),
    updateAgentSkillsOnly: jest.fn(),
  },
}));

jest.mock('../../agent-lifecycle/service', () => ({
  AgentLifecycleService: jest.fn().mockImplementation(() => ({
    activate: jest.fn(),
    pause: jest.fn(),
    archive: jest.fn(),
    ensureSchedulerJob: jest.fn(),
  })),
}));

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

const COORD_URL = 'https://coordinator-service-abc-uw.a.run.app';
const PUSH_SA = 'YOUR_SERVICE_ACCOUNT@YOUR_PROJECT.iam.gserviceaccount.com';

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
      messageId: opts.messageId ?? 'msg-int-1',
      publishTime: '2026-05-14T00:00:00.000Z',
      deliveryAttempt: opts.deliveryAttempt,
    },
    subscription: 'projects/YOUR_CONTROL_PROJECT_STAGING/subscriptions/control-plane-events-dev-coordinator-push',
  };
}

const ORIGINAL_ENV = { ...process.env };

beforeEach(() => {
  queries.length = 0;
  verifyGoogleOidcTokenMock.mockReset();
  process.env.COORDINATOR_SERVICE_URL = COORD_URL;
  process.env.PUBSUB_PUSH_SA_EMAIL = PUSH_SA;
  verifyGoogleOidcTokenMock.mockResolvedValue({
    ok: true,
    payload: { email: PUSH_SA, email_verified: true, iss: 'https://accounts.google.com' },
  });
});

afterEach(() => {
  process.env = { ...ORIGINAL_ENV };
});

describe('POST /internal/pubsub/control-plane-events — real dispatchEvent', () => {
  it('schema-invalid event with valid tenant_id → 204 + INSERT INTO dlq_messages row', async () => {
    const VALID_TENANT = '11111111-1111-4111-8111-111111111111';
    const app = buildApp();
    const res = await request(app)
      .post('/internal/pubsub/control-plane-events')
      .set('Authorization', 'Bearer good-token')
      .send(
        envelope(
          {
            // Missing required fields: entity_type, entity_id, event_type.
            // validateEventSchema in subscriber.ts rejects this → dispatchEvent
            // writes to dlq_messages → throws DlqRoutedError → push handler 204.
            event_id: 'evt-bad-1',
            tenant_id: VALID_TENANT,
            payload: {},
          },
          { deliveryAttempt: 1 },
        ),
      );

    expect(res.status).toBe(204);
    const dlqInsert = queries.find((q) => /INSERT INTO dlq_messages/i.test(q.sql));
    expect(dlqInsert).toBeDefined();
    // Params: [id (uuid), original_topic (event_type), original_message_id (event_id),
    //         tenant_id, payload (json), error_message]
    expect(dlqInsert!.params).toEqual(
      expect.arrayContaining([
        VALID_TENANT,
        expect.stringMatching(/Missing event_type|Missing entity_type|Missing entity_id/),
      ]),
    );
  });

  it('schema-invalid event with malformed tenant_id → 204 + DLQ row uses sentinel UUID + error notes original', async () => {
    const SENTINEL = '00000000-0000-0000-0000-000000000000';
    const app = buildApp();
    const res = await request(app)
      .post('/internal/pubsub/control-plane-events')
      .set('Authorization', 'Bearer good-token')
      .send(
        envelope(
          {
            event_id: 'evt-bad-2',
            tenant_id: 'not-a-uuid',
            payload: {},
          },
          { deliveryAttempt: 1 },
        ),
      );

    expect(res.status).toBe(204);
    const dlqInsert = queries.find((q) => /INSERT INTO dlq_messages/i.test(q.sql));
    expect(dlqInsert).toBeDefined();
    expect(dlqInsert!.params).toEqual(
      expect.arrayContaining([
        SENTINEL,
        expect.stringMatching(/\[malformed tenant_id=not-a-uuid\].*Missing/),
      ]),
    );
  });

  it('valid event with unknown event_type → 204, no dlq_messages row (validator passes; switch defaults to warn-and-ack)', async () => {
    const app = buildApp();
    const res = await request(app)
      .post('/internal/pubsub/control-plane-events')
      .set('Authorization', 'Bearer good-token')
      .send(
        envelope(
          {
            event_id: 'evt-unknown-1',
            event_type: 'tenant.totally.unknown',
            entity_type: 'tenant',
            entity_id: 'tenant-1',
            tenant_id: 'tenant-1',
            payload: {},
          },
          { deliveryAttempt: 1 },
        ),
      );

    expect(res.status).toBe(204);
    const dlqInsert = queries.find((q) => /INSERT INTO dlq_messages/i.test(q.sql));
    expect(dlqInsert).toBeUndefined();
  });
});
