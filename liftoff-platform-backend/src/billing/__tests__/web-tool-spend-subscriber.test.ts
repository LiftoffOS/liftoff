/**
 * Phase 4 PB-6 of the deep-research-realtime-billing plan.
 *
 * Pub/Sub push subscriber endpoint POST /api/internal/billing/web-tool-event.
 * Verifies OIDC token allow-list, payload decode, account resolution, and
 * delegation to ingestEventWithBuckets with baseSourceId=payload.idempotencyKey.
 */

const mockVerifyIdToken = jest.fn();
jest.mock('google-auth-library', () => ({
  OAuth2Client: jest.fn().mockImplementation(() => ({
    verifyIdToken: (...a: unknown[]) => mockVerifyIdToken(...a),
  })),
}));

const mockIngestEventWithBuckets = jest.fn();
const mockResolveAccountIdForTenant = jest.fn();
jest.mock('../../cost-attribution/repository', () => ({
  ingestEventWithBuckets: (...a: unknown[]) => mockIngestEventWithBuckets(...a),
  resolveAccountIdForTenant: (...a: unknown[]) => mockResolveAccountIdForTenant(...a),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// INV-PB-009: the subscriber translates the runtime agents.id it receives into
// internal_agents.id before writing. Mocked here both to assert that translation
// and because the real module transitively imports @liftoffos/service-client,
// which constructs a GoogleAuth at module load — this suite's
// google-auth-library mock only provides OAuth2Client, so the import would throw.
const mockGetRuntimeToInternalMap = jest.fn();
// Only the NETWORK half is stubbed. `toInternalAgentId` is the real one:
// this mock used to hand-copy its body, which froze the translator's behaviour
// at the moment the copy was written. The no-agent sentinel rule then moved
// INTO the translator and this suite kept asserting against the old copy —
// a test passing on a reimplementation of the thing it is testing.
jest.mock('../../internal-agents/runtime-agent-id-map', () => ({
  ...jest.requireActual('../../internal-agents/runtime-agent-id-map'),
  getRuntimeToInternalMap: (...a: unknown[]) => mockGetRuntimeToInternalMap(...a),
}));

process.env.ENVIRONMENT = 'dev';
process.env.GCP_PROJECT_ID = 'example-control-staging';
process.env.WEB_TOOL_PUBSUB_PUSH_SA_EMAIL = 'platform-backend@example-project.iam.gserviceaccount.com';
process.env.PLATFORM_BACKEND_URL = 'https://platform-backend.example.com';

import express, { Express } from 'express';
import request from 'supertest';
import { webToolSpendSubscriberRouter } from '../web-tool-spend-subscriber';

function makeApp(): Express {
  const app = express();
  app.use(express.json({ limit: '2mb' }));
  app.use('/', webToolSpendSubscriberRouter);
  return app;
}

function envelope(payload: unknown): Record<string, unknown> {
  return {
    message: { data: Buffer.from(JSON.stringify(payload)).toString('base64') },
    subscription: 'projects/p/subscriptions/sub',
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockVerifyIdToken.mockResolvedValue({
    getPayload: () => ({ email: 'platform-backend@example-project.iam.gserviceaccount.com' }),
  });
  mockResolveAccountIdForTenant.mockResolvedValue('acct-1');
  mockIngestEventWithBuckets.mockResolvedValue(1);
  mockGetRuntimeToInternalMap.mockResolvedValue(new Map());
});

describe('POST /api/internal/billing/web-tool-event', () => {
  const PAYLOAD = {
    tenantId:       'tenant-1',
    agentId:        'agent-1',
    invocationId:   'inv-1',
    connector:      'perplexity',
    eventType:      'web_deep_research',
    costUsd:        0.40,
    occurredAt:     '2026-06-02T00:00:00Z',
    idempotencyKey: 'deep-research-id-1',
    metadata:       { is_pre_charge: true, reasoning_effort: 'medium' },
  };

  it('rejects with 401 when Authorization header is missing', async () => {
    const res = await request(makeApp())
      .post('/api/internal/billing/web-tool-event')
      .send(envelope(PAYLOAD));
    expect(res.status).toBe(401);
    expect(mockIngestEventWithBuckets).not.toHaveBeenCalled();
  });

  it('rejects with 401 when OIDC SA email does NOT match the allow-list', async () => {
    mockVerifyIdToken.mockResolvedValueOnce({
      getPayload: () => ({ email: 'unauthorized@evil.com' }),
    });
    const res = await request(makeApp())
      .post('/api/internal/billing/web-tool-event')
      .set('Authorization', 'Bearer xyz')
      .send(envelope(PAYLOAD));
    expect(res.status).toBe(401);
    expect(mockIngestEventWithBuckets).not.toHaveBeenCalled();
  });

  it('ACKs (200) malformed payload to avoid Pub/Sub redelivery loop', async () => {
    const res = await request(makeApp())
      .post('/api/internal/billing/web-tool-event')
      .set('Authorization', 'Bearer xyz')
      .send({ message: { data: 'not-base64-json-garbage' } });
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/ack-malformed/);
  });

  it('ACKs (200) with ack-no-account when tenant cannot be resolved', async () => {
    mockResolveAccountIdForTenant.mockResolvedValueOnce(null);
    const res = await request(makeApp())
      .post('/api/internal/billing/web-tool-event')
      .set('Authorization', 'Bearer xyz')
      .send(envelope(PAYLOAD));
    expect(res.status).toBe(200);
    expect(res.text).toMatch(/ack-no-account/);
    expect(mockIngestEventWithBuckets).not.toHaveBeenCalled();
  });

  it('delegates to ingestEventWithBuckets with baseSourceId = payload.idempotencyKey', async () => {
    const res = await request(makeApp())
      .post('/api/internal/billing/web-tool-event')
      .set('Authorization', 'Bearer xyz')
      .send(envelope(PAYLOAD));
    expect(res.status).toBe(200);
    expect(mockIngestEventWithBuckets).toHaveBeenCalledTimes(1);
    const [accountId, sourceId, costUsd, template] = mockIngestEventWithBuckets.mock.calls[0];
    expect(accountId).toBe('acct-1');
    expect(sourceId).toBe('deep-research-id-1');
    expect(costUsd).toBeCloseTo(0.40);
    // event_type collapsed to 'web_tool'; specific tool moves to action_type.
    expect(template.eventType).toBe('web_tool');
    expect(template.actionType).toBe('web_deep_research');
    expect(template.connector).toBe('perplexity');
    expect(template.source).toBe('tenant_runtime');
    expect(template.tenantId).toBe('tenant-1');
    expect(template.invocationId).toBe('inv-1');
  });

  it('routes a wallet-funded call (the Browserbase rung) to the x402 branch, counted per call', async () => {
    // Same routing as the feed backstop: the row must land in
    // cost_bucket='x402_wallet_funded', which the on-chain reconciliation sums.
    // This subscriber lands first, so booking it anywhere else would stick.
    const res = await request(makeApp())
      .post('/api/internal/billing/web-tool-event')
      .set('Authorization', 'Bearer xyz')
      .send(envelope({
        ...PAYLOAD,
        connector: 'browserbase_x402',
        eventType: 'web_fetch_advanced',
        costUsd: 0.01,
        idempotencyKey: 'rung-call-1',
        metadata: { funding: 'x402_wallet', tool_name: 'web_fetch_advanced' },
      }));
    expect(res.status).toBe(200);
    const [, sourceId, costUsd, template] = mockIngestEventWithBuckets.mock.calls[0];
    expect(sourceId).toBe('rung-call-1');
    expect(costUsd).toBeCloseTo(0.01);
    expect(template).toEqual(expect.objectContaining({
      connector: 'browserbase_x402', actionType: 'web_fetch_advanced', eventType: 'web_tool',
      x402Funded: true, usageQuantity: 1, usageUnit: 'call',
    }));
    expect(template.webToolFunding).toBeUndefined();
  });

  it('leaves platform-funded and unmarked rows off the x402 branch', async () => {
    for (const metadata of [{ funding: 'platform' }, {}]) {
      mockIngestEventWithBuckets.mockClear();
      await request(makeApp())
        .post('/api/internal/billing/web-tool-event')
        .set('Authorization', 'Bearer xyz')
        .send(envelope({ ...PAYLOAD, connector: 'steel', eventType: 'web_fetch_advanced', metadata }))
        .expect(200);
      const [, , , template] = mockIngestEventWithBuckets.mock.calls[0];
      expect(template.x402Funded).toBeUndefined();
      expect(template.usageQuantity).toBeUndefined();
      expect(template.webToolFunding).toBe(metadata.funding === 'platform' ? 'platform' : undefined);
    }
  });

  it('forwards signed (negative) costUsd unchanged so PB-3 routes refunds through applyOuRefund', async () => {
    const refundPayload = { ...PAYLOAD, costUsd: -0.30, idempotencyKey: 'deep-research-id-1/delta' };
    const res = await request(makeApp())
      .post('/api/internal/billing/web-tool-event')
      .set('Authorization', 'Bearer xyz')
      .send(envelope(refundPayload));
    expect(res.status).toBe(200);
    const [, sourceId, costUsd] = mockIngestEventWithBuckets.mock.calls[0];
    expect(sourceId).toBe('deep-research-id-1/delta');
    expect(costUsd).toBeCloseTo(-0.30);
  });

  // INV-PB-009 — the runtime publishes ctx.agentId (runtime agents.id) on this
  // topic.
  it('translates the runtime agent id to the control-plane id before writing', async () => {
    mockGetRuntimeToInternalMap.mockResolvedValue(new Map([['agent-1', 'internal-agent-1']]));
    const res = await request(makeApp())
      .post('/api/internal/billing/web-tool-event')
      .set('Authorization', 'Bearer xyz')
      .send(envelope(PAYLOAD));
    expect(res.status).toBe(200);
    expect(mockGetRuntimeToInternalMap).toHaveBeenCalledWith('tenant-1');
    const [, , , template] = mockIngestEventWithBuckets.mock.calls[0];
    expect(template.agentId).toBe('internal-agent-1');
  });

  it('writes the internal id the runtime sent without asking the runtime to translate', async () => {
    const res = await request(makeApp())
      .post('/api/internal/billing/web-tool-event')
      .set('Authorization', 'Bearer xyz')
      .send(envelope({ ...PAYLOAD, internalAgentId: 'internal-agent-1' }));
    expect(res.status).toBe(200);
    // The translation is a call to the runtime's agent-service, which bills by
    // the instance; a charge that already carries the id must not wake it.
    expect(mockGetRuntimeToInternalMap).not.toHaveBeenCalled();
    const [, , , template] = mockIngestEventWithBuckets.mock.calls[0];
    expect(template.agentId).toBe('internal-agent-1');
  });

  it('passes an already-internal id through untouched (translation is identity-preserving)', async () => {
    mockGetRuntimeToInternalMap.mockResolvedValue(new Map([['some-other-runtime-id', 'x']]));
    const res = await request(makeApp())
      .post('/api/internal/billing/web-tool-event')
      .set('Authorization', 'Bearer xyz')
      .send(envelope(PAYLOAD));
    expect(res.status).toBe(200);
    const [, , , template] = mockIngestEventWithBuckets.mock.calls[0];
    expect(template.agentId).toBe('agent-1');
  });

  it('keeps an unattributed event unattributed (null agentId stays null)', async () => {
    mockGetRuntimeToInternalMap.mockResolvedValue(new Map());
    const res = await request(makeApp())
      .post('/api/internal/billing/web-tool-event')
      .set('Authorization', 'Bearer xyz')
      .send(envelope({ ...PAYLOAD, agentId: undefined }));
    expect(res.status).toBe(200);
    const [, , , template] = mockIngestEventWithBuckets.mock.calls[0];
    expect(template.agentId).toBeNull();
  });

  it('returns 500 on ingest exception so Pub/Sub retries (→ DLQ after 5 attempts)', async () => {
    mockIngestEventWithBuckets.mockRejectedValueOnce(new Error('db blip'));
    const res = await request(makeApp())
      .post('/api/internal/billing/web-tool-event')
      .set('Authorization', 'Bearer xyz')
      .send(envelope(PAYLOAD));
    expect(res.status).toBe(500);
  });
});

/** A platform assistant's browser session.
 *
 * Liftoff, the Insights Manager and the Chief AI Officer have no agent row, so
 * the runtime stores their sessions under the nil-UUID sentinel — its agent
 * column is NOT NULL and has to hold something. That value must not survive
 * into cost reporting: toInternalAgentId passes an unmapped id through
 * UNCHANGED, and the per-agent cost report filters `agent_id IS NOT NULL`, so
 * the customer would be shown an agent they do not have, holding all three
 * assistants' browser spend.
 */
describe('a browser session with no agent', () => {
  const NIL = '00000000-0000-0000-0000-000000000000';
  const sessionPayload = (over: Record<string, unknown> = {}) => ({
    tenantId:       'tenant-1',
    agentId:        NIL,
    threadId:       'thread-1',
    connector:      'browser_use',
    eventType:      'browser_session',
    purpose:        'liftoff',
    costUsd:        0.00066,
    occurredAt:     '2026-09-05T10:00:00Z',
    idempotencyKey: 'browser_use_session:vs-1',
    ...over,
  });

  it('writes a NULL agent rather than the sentinel', async () => {
    await request(makeApp()).post('/api/internal/billing/web-tool-event')
      .set('Authorization', 'Bearer xyz')
      .send(envelope(sessionPayload())).expect(200);

    expect(mockIngestEventWithBuckets).toHaveBeenCalledWith(
      'acct-1', expect.anything(), expect.anything(),
      expect.objectContaining({ agentId: null }),
    );
  });

  it('files WHICH assistant it was as the purpose', async () => {
    await request(makeApp()).post('/api/internal/billing/web-tool-event')
      .set('Authorization', 'Bearer xyz')
      .send(envelope(sessionPayload({ purpose: 'team_plan' }))).expect(200);

    expect(mockIngestEventWithBuckets).toHaveBeenCalledWith(
      'acct-1', expect.anything(), expect.anything(),
      expect.objectContaining({ purpose: 'team_plan' }),
    );
  });

  it('still charges the tenant — this is their usage, not platform overhead', async () => {
    // source stays 'tenant_runtime', which classifyWhoseWorkload treats as
    // customer workload. The agent_id-null -> platform_overhead fallthrough is
    // scoped to source === 'platform_llm' and must not start applying here.
    await request(makeApp()).post('/api/internal/billing/web-tool-event')
      .set('Authorization', 'Bearer xyz')
      .send(envelope(sessionPayload())).expect(200);

    expect(mockIngestEventWithBuckets).toHaveBeenCalledWith(
      'acct-1', expect.anything(), expect.anything(),
      expect.objectContaining({ source: 'tenant_runtime' }),
    );
  });

  it('leaves a TEAM agent translated exactly as before', async () => {
    mockGetRuntimeToInternalMap.mockResolvedValue(new Map([['runtime-agent-1', 'internal-agent-1']]));

    await request(makeApp()).post('/api/internal/billing/web-tool-event')
      .set('Authorization', 'Bearer xyz')
      .send(envelope(sessionPayload({ agentId: 'runtime-agent-1', purpose: undefined }))).expect(200);

    expect(mockIngestEventWithBuckets).toHaveBeenCalledWith(
      'acct-1', expect.anything(), expect.anything(),
      expect.objectContaining({ agentId: 'internal-agent-1', purpose: null }),
    );
  });
});
