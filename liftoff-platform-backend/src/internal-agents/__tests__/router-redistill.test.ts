// Router-level integration tests for the §4 idempotency-key wrap on the
// redistill endpoints. Heavy services are mocked; the focus is the route's
// idempotency-key plumbing and the X-Idempotency-Replay header on cache hits.

import express from 'express';
import request from 'supertest';

const mockListAllByTenant = jest.fn();
const mockGetById = jest.fn();
const mockUpdate = jest.fn();
const mockDistill = jest.fn();
const mockGetCatalog = jest.fn();
const mockWithIdempotency = jest.fn();

jest.mock('../service', () => ({
  internalAgentService: {
    listAllByTenant: (...args: unknown[]) => mockListAllByTenant(...args),
    getById: (...args: unknown[]) => mockGetById(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
  },
}));

jest.mock('../distill-service', () => ({
  distillInternalAgent: (...args: unknown[]) => mockDistill(...args),
}));

jest.mock('../../connectors/connector-service-client', () => ({
  getCatalog: (...args: unknown[]) => mockGetCatalog(...args),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

jest.mock('../../infrastructure/idempotency', () => ({
  withIdempotency: (...args: unknown[]) => mockWithIdempotency(...args),
}));

jest.mock('../../infrastructure/idempotency-middleware', () => ({
  withIdempotencyMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../infrastructure/audit-context', () => ({ auditCtx: () => ({}) }));

jest.mock('../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: jest.fn(async () => ({ id: 'actor-1' })),
  })),
}));
jest.mock('../../accounts/repository', () => ({ AccountRepository: jest.fn() }));
jest.mock('../../tenant-members/service', () => ({
  tenantMembersService: {
    getMembership: jest.fn(async () => ({ role: 'admin' })),
  },
}));
jest.mock('../../llm/usage-tracker', () => ({ attributeSessionToAgent: jest.fn() }));
jest.mock('../../connectors/tenant-runtime-client', () => ({ tenantRuntimeClient: {} }));
jest.mock('../../billing/execution-guard', () => ({ checkExecutionAllowed: jest.fn(async () => true) }));
jest.mock('../../billing/subscription-items-service', () => ({ updateAgentQuantity: jest.fn() }));
jest.mock('../../infrastructure/database', () => ({ pool: { query: jest.fn() } }));
jest.mock('../events', () => ({ publishInternalAgentEvent: jest.fn() }));
jest.mock('../event-payload', () => ({ buildInternalAgentEventPayload: jest.fn(async () => ({})) }));
// The router now redacts the compiled prompt at the response boundary, so the
// real redaction helpers have to survive this mock; a bare jest.fn() module
// left them undefined and every create/update 500'd.
jest.mock('../row-mapper', () => {
  const actual = jest.requireActual('../row-mapper');
  return {
    ...actual,
    mapInternalAgentRow: jest.fn(),
  };
});
jest.mock('../../event-sources/routes', () => ({ webhookManagementRouter: express.Router() }));
jest.mock('@liftoffos/service-client', () => ({
  verifyServiceAuth: jest.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));
jest.mock('../../infrastructure/scheduler-auth', () => ({
  requireSchedulerOidc: jest.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));
jest.mock('express-rate-limit', () => () => (_req: unknown, _res: unknown, next: () => void) => next());
jest.mock('../../knowledge/repository', () => ({ findByIds: jest.fn() }));

const mockRateLimit = jest.fn();
jest.mock('../../common/chat-rate-limiter', () => ({
  checkAndIncrementChatRateLimit: (...args: unknown[]) => mockRateLimit(...args),
}));

import { internalAgentsRouter } from '../router';

function buildApp() {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => { (req as { ctx?: object }).ctx = { userId: 'firebase-uid-1' }; next(); });
  app.use('/api/internal-agents', internalAgentsRouter);
  return app;
}

const TENANT = '00000000-0000-0000-0000-0000000000aa';

describe('redistill idempotency-key wrap', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRateLimit.mockResolvedValue({ allowed: true, remaining: { minute: 1, hour: 1, day: 1 } });
  });

  it('passes the idempotency-key handler through withIdempotency on POST /redistill-all', async () => {
    mockWithIdempotency.mockResolvedValueOnce({ cached: false, status: 200, response: { totalAgents: 0 } });
    const app = buildApp();
    await request(app)
      .post(`/api/internal-agents/redistill-all?tenantId=${TENANT}`)
      .set('idempotency-key', 'idem-1')
      .expect(200);
    expect(mockWithIdempotency).toHaveBeenCalledTimes(1);
    const args = mockWithIdempotency.mock.calls[0];
    expect(args[0]).toBe(TENANT);
    expect(args[1]).toBe('idem-1');
    expect(args[2]).toBe('POST /api/internal-agents/redistill-all');
  });

  it('sets X-Idempotency-Replay header on cache hit', async () => {
    mockWithIdempotency.mockResolvedValueOnce({ cached: true, status: 200, response: { totalAgents: 0 } });
    const app = buildApp();
    const res = await request(app)
      .post(`/api/internal-agents/redistill-all?tenantId=${TENANT}`)
      .set('idempotency-key', 'idem-2')
      .expect(200);
    expect(res.headers['x-idempotency-replay']).toBe('true');
  });

  it('skips withIdempotency entirely when no idempotency-key is present', async () => {
    mockListAllByTenant.mockResolvedValueOnce([]);
    const app = buildApp();
    await request(app)
      .post(`/api/internal-agents/redistill-all?tenantId=${TENANT}`)
      .expect(200);
    expect(mockWithIdempotency).not.toHaveBeenCalled();
  });

  it('forwards ?dryRun=true to redistillAllAgents (skips service.update)', async () => {
    mockListAllByTenant.mockResolvedValueOnce([]);
    const app = buildApp();
    const res = await request(app)
      .post(`/api/internal-agents/redistill-all?tenantId=${TENANT}&dryRun=true`)
      .expect(200);
    expect(res.body.dryRun).toBe(true);
    expect(mockUpdate).not.toHaveBeenCalled();
  });
});

// Redistillation is the most expensive LLM call in the product, and
// `/redistill-all` multiplies it by the whole fleet. The distill-stream surface
// has been metered since D-5.10; these routes reach the SAME distillation, so
// leaving them unmetered governed the cheap door and not the expensive one.
describe('redistill is metered', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRateLimit.mockResolvedValue({ allowed: true, remaining: { minute: 1, hour: 1, day: 1 } });
    mockListAllByTenant.mockResolvedValue([]);
    mockGetById.mockResolvedValue({ id: 'agent-1', tenantId: TENANT, role: 'r', responsibilities: 'x' });
  });

  it('meters a fleet-wide redistill against the account, not the Firebase uid', async () => {
    // The ledger keys on `account_id UUID`. Passing the uid straight through is
    // how the sibling surface spent months failing every insert and taking the
    // limiter's fail-open branch on every request.
    await request(buildApp()).post(`/api/internal-agents/redistill-all?tenantId=${TENANT}`).expect(200);
    expect(mockRateLimit).toHaveBeenCalledWith(
      expect.objectContaining({
        tableName: 'distill_rate_limit_events',
        tenantId: TENANT,
        accountId: 'actor-1',
      }),
    );
  });

  it('meters a dry run too — it distills, it only withholds the write', async () => {
    await request(buildApp())
      .post(`/api/internal-agents/redistill-all?tenantId=${TENANT}&dryRun=true`)
      .expect(200);
    expect(mockRateLimit).toHaveBeenCalled();
  });

  it('refuses with 429 and a retry hint when the caller is over', async () => {
    mockRateLimit.mockResolvedValue({ allowed: false, retryAfter: 42, remaining: { minute: 0, hour: 0, day: 0 } });
    const res = await request(buildApp())
      .post(`/api/internal-agents/redistill-all?tenantId=${TENANT}`)
      .expect(429);
    expect(res.body.errorCode).toBe('rate_limited');
    expect(res.body.retryAfter).toBe(42);
  });

  it('spends NO distillation on a refused request', async () => {
    // The meter runs before the LLM work, which is the only placement that
    // saves anything.
    mockRateLimit.mockResolvedValue({ allowed: false, retryAfter: 1, remaining: { minute: 0, hour: 0, day: 0 } });
    await request(buildApp()).post(`/api/internal-agents/redistill-all?tenantId=${TENANT}`).expect(429);
    expect(mockListAllByTenant).not.toHaveBeenCalled();
    expect(mockDistill).not.toHaveBeenCalled();
  });

  it('meters the single-agent route too, so looping over agents is not a bypass', async () => {
    mockRateLimit.mockResolvedValue({ allowed: false, retryAfter: 1, remaining: { minute: 0, hour: 0, day: 0 } });
    await request(buildApp())
      .post(`/api/internal-agents/agent-1/redistill?tenantId=${TENANT}`)
      .expect(429);
    expect(mockDistill).not.toHaveBeenCalled();
  });

  it('rejects a non-UUID tenantId before it reaches the uuid column', async () => {
    await request(buildApp())
      .post(`/api/internal-agents/redistill-all?tenantId=not-a-uuid`)
      .expect(400);
    expect(mockRateLimit).not.toHaveBeenCalled();
  });
});
