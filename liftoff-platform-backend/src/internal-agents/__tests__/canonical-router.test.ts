import express from 'express';
import request from 'supertest';
import { jest } from '@jest/globals';

const queryMock = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: (_t: unknown, fn: (c: { query: typeof queryMock }) => Promise<unknown>) =>
    fn({ query: queryMock }),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

// Mock verifyServiceAuth faithfully: 401 unless X-Service-Auth matches an
// expected token. The test then covers both the auth-pass and auth-reject
// paths against the real router mount.
const EXPECTED_TOKEN = 'test-token';
jest.mock('@liftoffos/service-client', () => ({
  verifyServiceAuth: () => (req: { headers: Record<string, string> }, res: { status: (n: number) => { json: (b: unknown) => void } }, next: () => void) => {
    if (req.headers['x-service-auth'] === EXPECTED_TOKEN) return next();
    return res.status(401).json({ error: 'unauthorized' });
  },
}));

// Mock the per-agent service + payload builder so the /full endpoint can
// be exercised without pulling in the full InternalAgentService stack
// (heavy side-effect imports — Stripe client, CircuitBreaker, etc.).
const getByIdMock = jest.fn();
const buildPayloadMock = jest.fn();
const updateStatusMock = jest.fn();
jest.mock('../service', () => ({
  internalAgentService: {
    getById: (...a: unknown[]) => getByIdMock(...a),
    updateStatus: (...a: unknown[]) => updateStatusMock(...a),
  },
}));
jest.mock('../event-payload', () => ({
  buildInternalAgentEventPayload: (...a: unknown[]) => buildPayloadMock(...a),
}));

import { canonicalAgentRuntimeRouter } from '../canonical-router';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/agent-runtime', canonicalAgentRuntimeRouter);
  return app;
}

beforeEach(() => { queryMock.mockReset(); });

function authed(req: request.Test): request.Test {
  return req.set('X-Service-Auth', EXPECTED_TOKEN);
}

describe('GET /canonical-agents', () => {
  it('returns 401 when X-Service-Auth header is missing', async () => {
    const res = await request(makeApp()).get('/api/internal/agent-runtime/canonical-agents?tenantId=00000000-0000-0000-0000-000000000001');
    expect(res.status).toBe(401);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns 401 when X-Service-Auth header is wrong', async () => {
    const res = await request(makeApp())
      .get('/api/internal/agent-runtime/canonical-agents?tenantId=00000000-0000-0000-0000-000000000001')
      .set('X-Service-Auth', 'wrong-token');
    expect(res.status).toBe(401);
    expect(queryMock).not.toHaveBeenCalled();
  });

  it('returns 400 on missing tenantId', async () => {
    const res = await authed(request(makeApp()).get('/api/internal/agent-runtime/canonical-agents'));
    expect(res.status).toBe(400);
  });

  it('returns 400 on non-uuid tenantId', async () => {
    const res = await authed(request(makeApp()).get('/api/internal/agent-runtime/canonical-agents?tenantId=abc'));
    expect(res.status).toBe(400);
  });

  it('returns the projection for an existing tenant', async () => {
    queryMock.mockResolvedValueOnce({
      rows: [{
        id: '11111111-1111-1111-1111-111111111111',
        role: 'Customer Support Representative',
        messaging_nickname: null,
        status: 'active',
        current_version: 8,
        trigger_config: { type: 'cron', cronExpr: '*/1 * * * *' },
        integrations: [{ integrationId: 'google_mail' }],
      }],
    });
    const res = await authed(request(makeApp())
      .get('/api/internal/agent-runtime/canonical-agents?tenantId=00000000-0000-0000-0000-000000000001'));
    expect(res.status).toBe(200);
    expect(res.body.agents).toHaveLength(1);
    expect(res.body.agents[0]).toMatchObject({
      id: '11111111-1111-1111-1111-111111111111',
      status: 'active',
      currentVersion: 8,
      triggerConfig: { type: 'cron', cronExpr: '*/1 * * * *' },
    });
  });

  it('omits soft-deleted agents (handled by SQL WHERE clause)', async () => {
    queryMock.mockResolvedValueOnce({ rows: [] });
    const res = await authed(request(makeApp())
      .get('/api/internal/agent-runtime/canonical-agents?tenantId=00000000-0000-0000-0000-000000000001'));
    expect(res.status).toBe(200);
    expect(res.body.agents).toEqual([]);
  });

  it('returns 500 on db error', async () => {
    queryMock.mockRejectedValueOnce(new Error('boom'));
    const res = await authed(request(makeApp())
      .get('/api/internal/agent-runtime/canonical-agents?tenantId=00000000-0000-0000-0000-000000000001'));
    expect(res.status).toBe(500);
  });
});

describe('GET /canonical-agents/:internalAgentId/full', () => {
  beforeEach(() => {
    getByIdMock.mockReset();
    buildPayloadMock.mockReset();
  });

  const url = (id: string) =>
    `/api/internal/agent-runtime/canonical-agents/${id}/full?tenantId=00000000-0000-0000-0000-000000000001`;

  it('returns the full event-payload-equivalent for an existing agent', async () => {
    getByIdMock.mockResolvedValueOnce({
      id: '22222222-2222-2222-2222-222222222222',
      tenantId: '00000000-0000-0000-0000-000000000001',
      role: 'Customer Support Representative',
      status: 'active',
    });
    buildPayloadMock.mockResolvedValueOnce({
      id: '22222222-2222-2222-2222-222222222222',
      tenantId: '00000000-0000-0000-0000-000000000001',
      name: 'Customer Support Representative',
      role: 'Customer Support Representative',
      status: 'active',
      agentType: 'agent',
      modelConfig: {},
      execConfig: {},
      memoryScope: {},
      systemPrompt: '',
      userInstructions: '',
      triggerConfig: { type: 'cron', cronExpr: '*/1 * * * *' },
      integrations: [],
    });
    const res = await authed(request(makeApp()).get(url('22222222-2222-2222-2222-222222222222')));
    expect(res.status).toBe(200);
    expect(res.body.payload).toMatchObject({
      id: '22222222-2222-2222-2222-222222222222',
      role: 'Customer Support Representative',
      triggerConfig: { type: 'cron', cronExpr: '*/1 * * * *' },
    });
    expect(getByIdMock).toHaveBeenCalledWith(
      '22222222-2222-2222-2222-222222222222',
      '00000000-0000-0000-0000-000000000001',
    );
    expect(buildPayloadMock).toHaveBeenCalledWith(
      expect.objectContaining({ id: '22222222-2222-2222-2222-222222222222' }),
      'tenant.internal_agent.created',
    );
  });

  it('returns 404 when the agent does not exist or is soft-deleted', async () => {
    getByIdMock.mockResolvedValueOnce(null);
    const res = await authed(request(makeApp()).get(url('33333333-3333-3333-3333-333333333333')));
    expect(res.status).toBe(404);
    expect(buildPayloadMock).not.toHaveBeenCalled();
  });

  it('rejects invalid agent UUIDs with 400', async () => {
    const res = await authed(request(makeApp())
      .get('/api/internal/agent-runtime/canonical-agents/not-a-uuid/full?tenantId=00000000-0000-0000-0000-000000000001'));
    expect(res.status).toBe(400);
  });

  it('rejects missing tenantId with 400', async () => {
    const res = await authed(request(makeApp())
      .get('/api/internal/agent-runtime/canonical-agents/22222222-2222-2222-2222-222222222222/full'));
    expect(res.status).toBe(400);
  });

  it('rejects unauth requests with 401', async () => {
    const res = await request(makeApp()).get(url('22222222-2222-2222-2222-222222222222'));
    expect(res.status).toBe(401);
  });

  it('returns 500 when the payload builder throws', async () => {
    getByIdMock.mockResolvedValueOnce({ id: 'x', tenantId: 'y' });
    buildPayloadMock.mockRejectedValueOnce(new Error('boom'));
    const res = await authed(request(makeApp()).get(url('22222222-2222-2222-2222-222222222222')));
    expect(res.status).toBe(500);
  });
});

// The runtime pauses an agent by asking for the SAME status change the
// dashboard's Pause button makes. That is the whole point of the endpoint: a
// stop recorded anywhere else is one the status column does not show and the
// Resume button cannot undo.
describe('POST /canonical-agents/:id/pause', () => {
  const AGENT = '11111111-1111-1111-1111-111111111111';
  const TENANT = '22222222-2222-2222-2222-222222222222';

  beforeEach(() => {
    updateStatusMock.mockReset();
    updateStatusMock.mockResolvedValue({ id: AGENT, status: 'paused' });
  });

  it('sets the agent status to paused', async () => {
    const res = await request(makeApp())
      .post(`/api/internal/agent-runtime/canonical-agents/${AGENT}/pause`)
      .set('X-Service-Auth', EXPECTED_TOKEN)
      .send({ tenantId: TENANT });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: 'paused' });
    expect(updateStatusMock).toHaveBeenCalledWith(AGENT, TENANT, 'paused');
  });

  it('rejects an unauthenticated caller', async () => {
    const res = await request(makeApp())
      .post(`/api/internal/agent-runtime/canonical-agents/${AGENT}/pause`)
      .send({ tenantId: TENANT });

    expect(res.status).toBe(401);
    expect(updateStatusMock).not.toHaveBeenCalled();
  });

  it('rejects a missing tenantId', async () => {
    const res = await request(makeApp())
      .post(`/api/internal/agent-runtime/canonical-agents/${AGENT}/pause`)
      .set('X-Service-Auth', EXPECTED_TOKEN)
      .send({});

    expect(res.status).toBe(400);
    expect(updateStatusMock).not.toHaveBeenCalled();
  });

  it('404s an agent that is not there', async () => {
    updateStatusMock.mockResolvedValue(null);
    const res = await request(makeApp())
      .post(`/api/internal/agent-runtime/canonical-agents/${AGENT}/pause`)
      .set('X-Service-Auth', EXPECTED_TOKEN)
      .send({ tenantId: TENANT });

    expect(res.status).toBe(404);
  });
});
