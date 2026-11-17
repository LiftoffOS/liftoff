// The two service-to-service routes the runtime actually calls, over HTTP.
//
// Separate from `managed-session.test.ts`, which asserts the functions behind
// them. What can only be seen at this level is the wire: whether the opt-in
// reaches the mint, what a declined door answers, what shape the usage read comes
// back in, and whether `since` survives being a query string. Each of those has
// failed silently in one direction — absent means "no capture", which is the state
// this whole change exists to leave behind.

const mockQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: (_t: string, fn: (c: { query: jest.Mock }) => Promise<unknown>) =>
    fn({ query: mockQuery }),
}));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));
// Service auth is proved by its own suite in @liftoffos/service-client; here it
// is a pass-through so the route's own decisions are what fail.
jest.mock('@liftoffos/service-client', () => ({
  verifyServiceAuth: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../infrastructure/control-plane-url', () => ({
  getBackendUrl: () => 'https://api-dev.example.com',
}));

const mockResolve = jest.fn();
jest.mock('../../tenant-ai-provider-keys/resolution-service', () => ({
  AGENT_INVOCATION_PURPOSE: 'agent_invocation',
  resolveByokCredential: (...a: unknown[]) => mockResolve(...a),
  keyVendorForProvider: (p: string) =>
    (['anthropic', 'openai', 'google', 'xai'].includes(p) ? p : null),
}));
jest.mock('../../tenant-ai-provider-keys/repository', () => ({ getKey: jest.fn() }));
jest.mock('../../tenant-ai-provider-keys/secret-storage', () => ({
  readProviderSecret: jest.fn(),
}));

const mockSubstitution = jest.fn();
jest.mock('../managed-fallback', () => ({
  canSubstituteManaged: (...a: unknown[]) => mockSubstitution(...a),
}));

import express from 'express';
import request from 'supertest';
import { byokGatewayInternalRouter } from '../internal-router';

const TENANT = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';
const RUN = 'f399e6ff-f11b-4b94-ad8e-9c23ca936a7e';

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use('/api/internal/byok', byokGatewayInternalRouter);
  return app;
}

const OPEN_BODY = {
  tenantId: TENANT,
  invocationId: RUN,
  resolvedProvider: 'anthropic',
  callKind: 'agent_invocation',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockQuery.mockResolvedValue({ rows: [], rowCount: 0 });
  mockSubstitution.mockResolvedValue(true);
  mockResolve.mockResolvedValue({ mode: 'managed', reason: 'purpose_not_eligible' });
});

describe('POST /session, when the resolver says managed', () => {
  it('mints a managed session for a caller that opted in', async () => {
    const res = await request(makeApp())
      .post('/api/internal/byok/session')
      .send({ ...OPEN_BODY, acceptManagedGateway: true });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      mode: 'managed_gateway',
      vendor: 'anthropic',
      baseUrl: 'https://api-dev.example.com/byok/anthropic',
      rerouteToVendorApi: false,
      // The decline reason travels either way: "why is this run not on the
      // customer's key" is the first question anyone asks.
      reason: 'purpose_not_eligible',
    });
    expect(typeof res.body.token).toBe('string');
    expect(res.body.expiresAt).toEqual(expect.any(String));
  });

  it('mints NOTHING for a caller that did not opt in', async () => {
    // A token is a row. The default has to be no-mint, or every llmClient call in
    // the estate writes a credential nobody presents.
    const res = await request(makeApp()).post('/api/internal/byok/session').send(OPEN_BODY);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ mode: 'managed', reason: 'purpose_not_eligible' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('REJECTS a non-boolean opt-in rather than reading it as truthy', async () => {
    // `"true"` is truthy in JavaScript and would turn the capture on for a caller
    // that never asked. A 400 the runtime logs is the loud version of that drift.
    const res = await request(makeApp())
      .post('/api/internal/byok/session')
      .send({ ...OPEN_BODY, acceptManagedGateway: 'true' });
    expect(res.status).toBe(400);
  });

  it('answers plain managed when the door cannot open', async () => {
    // Google with no project, xAI with no OpenRouter key. Handing the runtime a
    // base URL that 502s turns a working turn into a failed one.
    mockSubstitution.mockResolvedValue(false);
    const res = await request(makeApp())
      .post('/api/internal/byok/session')
      .send({ ...OPEN_BODY, acceptManagedGateway: true });
    expect(res.body).toEqual({ mode: 'managed', reason: 'purpose_not_eligible' });
    expect(mockQuery).not.toHaveBeenCalled();
  });

  it('answers plain managed for a provider with no door at all', async () => {
    // `anthropic-vertex` bills Liftoff's GCP account over ADC: no API key in the
    // path to substitute, so there is nothing for this door to serve.
    const res = await request(makeApp())
      .post('/api/internal/byok/session')
      .send({ ...OPEN_BODY, resolvedProvider: 'anthropic-vertex', acceptManagedGateway: true });
    expect(res.body).toEqual({ mode: 'managed', reason: 'purpose_not_eligible' });
  });

  it('routes an OpenRouter-hosted family to the openrouter door', async () => {
    // `keyVendorForProvider` answers null for GLM — correctly, no customer key can
    // settle an OpenRouter invoice — and a managed session is asking the other
    // question: which WIRE does this go out on.
    const res = await request(makeApp())
      .post('/api/internal/byok/session')
      .send({ ...OPEN_BODY, resolvedProvider: 'glm', acceptManagedGateway: true });
    expect(res.body).toMatchObject({
      mode: 'managed_gateway',
      vendor: 'openrouter',
      baseUrl: 'https://api-dev.example.com/byok/openrouter',
    });
  });

  it('sends Liftoff\'s own Vertex target on a managed google session', async () => {
    // A Vertex client cannot build a request path without a project and a
    // location, and the runtime checks the location against the endpoint its rate
    // table prices.
    const previous = process.env.GCP_PROJECT_ID;
    process.env.GCP_PROJECT_ID = 'example-control-staging';
    try {
      const res = await request(makeApp())
        .post('/api/internal/byok/session')
        .send({ ...OPEN_BODY, resolvedProvider: 'google', acceptManagedGateway: true });
      expect(res.body.vendor).toBe('google');
      expect(res.body.vertex).toEqual({
        project: 'example-control-staging',
        location: 'global',
      });
    } finally {
      if (previous === undefined) delete process.env.GCP_PROJECT_ID;
      else process.env.GCP_PROJECT_ID = previous;
    }
  });

  it('degrades to managed rather than failing the run when the mint throws', async () => {
    mockQuery.mockRejectedValue(new Error('database away'));
    const res = await request(makeApp())
      .post('/api/internal/byok/session')
      .send({ ...OPEN_BODY, acceptManagedGateway: true });
    expect(res.status).toBe(200);
    expect(res.body.mode).toBe('managed');
  });
});

describe('GET /session/usage', () => {
  const row = {
    requests: '3',
    incomplete: '0',
    input_tokens: '1200',
    output_tokens: '6231',
    cache_read_tokens: '28015',
    cache_write_tokens: '31300',
    reasoning_tokens: '6028',
    vendor_cost_usd: '0.0185399000',
    vendor_cost_requests: '3',
  };

  it('returns the summed counts in the shape the runtime parses', async () => {
    mockQuery.mockResolvedValue({ rows: [row] });
    const res = await request(makeApp())
      .get('/api/internal/byok/session/usage')
      .query({ tenantId: TENANT, invocationId: RUN });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      requests: 3,
      incomplete: 0,
      inputTokens: 1200,
      outputTokens: 6231,
      cacheReadTokens: 28015,
      cacheWriteTokens: 31300,
      reasoningTokens: 6028,
      // The charge, and the count that says the sum is complete. Both have to
      // survive JSON: a cost that arrived as a string would compare false against
      // every number and silently disable the preference.
      vendorCostUsd: 0.0185399,
      vendorCostRequests: 3,
    });
  });

  it('carries `since` through as a real timestamp, not a string', async () => {
    // It arrives as a query string and has to reach the predicate as an instant.
    // A string that silently failed to parse would widen the sum to the whole run
    // and let a continuation be charged for the paused half's requests.
    mockQuery.mockResolvedValue({ rows: [row] });
    const since = '2026-09-26T18:00:00.000Z';
    await request(makeApp())
      .get('/api/internal/byok/session/usage')
      .query({ tenantId: TENANT, invocationId: RUN, since });
    const params = mockQuery.mock.calls[0][1];
    expect(params[2]).toBeInstanceOf(Date);
    expect((params[2] as Date).toISOString()).toBe(since);
  });

  it('REJECTS a since that is not a timestamp', async () => {
    const res = await request(makeApp())
      .get('/api/internal/byok/session/usage')
      .query({ tenantId: TENANT, invocationId: RUN, since: 'yesterday' });
    expect(res.status).toBe(400);
  });

  it('REQUIRES the tenant, because the rows are tenant-scoped', async () => {
    // A run id alone would be a cross-tenant read waiting for a caller to make it.
    const res = await request(makeApp())
      .get('/api/internal/byok/session/usage')
      .query({ invocationId: RUN });
    expect(res.status).toBe(400);
  });

  it('answers 503 rather than an empty sum when the read fails', async () => {
    // Zeroes would be taken for "the gateway saw nothing" and the engine's own
    // numbers kept — right for a run that never came through the door, WRONG for a
    // run whose figures we simply failed to read. Saying so lets the caller keep
    // the engine's numbers knowingly.
    mockQuery.mockRejectedValue(new Error('database away'));
    const res = await request(makeApp())
      .get('/api/internal/byok/session/usage')
      .query({ tenantId: TENANT, invocationId: RUN });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ error: 'usage_read_failed' });
  });
});
