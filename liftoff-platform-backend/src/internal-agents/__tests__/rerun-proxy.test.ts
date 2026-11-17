// ADR-030: tests for the PB "Run again" proxy route
// POST /api/internal-agents/:internalAgentId/runs/:invocationId/rerun
//
// Verifies the route relays the Tenant Runtime's status + body (202 accept,
// 422 not-re-runnable), 404s an unknown agent, and 400s a missing tenantId.
// Heavy router deps are mocked so the router module imports; the focus is the
// proxy relay behaviour.

import express from 'express';
import request from 'supertest';

const mockGetById = jest.fn();
const mockRerun = jest.fn();
// The route resolves the Firebase uid on the request to an accounts.id
// and forwards it, so the re-run is attributed to the person who clicked.
const mockGetByFirebaseUid = jest.fn();

jest.mock('../service', () => ({
  internalAgentService: {
    create: jest.fn(),
    update: jest.fn(),
    getById: (...args: unknown[]) => mockGetById(...args),
  },
}));

jest.mock('../../connectors/tenant-runtime-client', () => ({
  tenantRuntimeClient: {
    rerunFailedRun: (...args: unknown[]) => mockRerun(...args),
  },
}));

// Auth middleware factories → passthrough so we exercise the proxy logic.
jest.mock('../../infrastructure/tenant-role-auth', () => ({
  requireMinRole: () => (_req: unknown, _res: unknown, next: () => void) => next(),
  verifyTenantOwnership: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

// ── Remaining router-import dependencies (mirrors router-pinned-knowledge.test) ──
jest.mock('../../knowledge/repository', () => ({ findByIds: jest.fn() }));
jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));
jest.mock('../../infrastructure/idempotency', () => ({
  withIdempotency: jest.fn(async (_t: string, _k: string, _e: string, _h: string, fn: () => Promise<unknown>) => {
    const result = (await fn()) as { status: number; body: unknown };
    return { cached: false, status: result.status, response: result.body };
  }),
}));
jest.mock('../../infrastructure/idempotency-middleware', () => ({
  withIdempotencyMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));
jest.mock('../../infrastructure/audit-context', () => ({ auditCtx: () => ({}) }));
jest.mock('../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: (...args: unknown[]) => mockGetByFirebaseUid(...args),
  })),
}));
jest.mock('../../accounts/repository', () => ({ AccountRepository: jest.fn() }));
jest.mock('../../tenant-members/service', () => ({ tenantMembersService: {} }));
jest.mock('../../llm/usage-tracker', () => ({ attributeSessionToAgent: jest.fn() }));
jest.mock('../../billing/execution-guard', () => ({ checkExecutionAllowed: jest.fn(async () => true) }));
jest.mock('../../billing/subscription-items-service', () => ({ updateAgentQuantity: jest.fn() }));
jest.mock('../../infrastructure/database', () => ({ pool: { query: jest.fn() } }));
jest.mock('../distill-service', () => ({ distillInternalAgent: jest.fn() }));
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

import { internalAgentsRouter } from '../router';

const TENANT = 't-1';
const AGENT = 'agent-1';
const INV = 'inv-1';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).ctx = { userId: 'u-1', tenantId: TENANT };
    (req as any).isPlatformAdmin = true;
    next();
  });
  app.use('/api/internal-agents', internalAgentsRouter);
  return app;
}

function post() {
  return request(buildApp()).post(`/api/internal-agents/${AGENT}/runs/${INV}/rerun?tenantId=${TENANT}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetById.mockResolvedValue({ id: AGENT, tenantId: TENANT, role: 'Agent' });
  mockGetByFirebaseUid.mockResolvedValue({ id: 'account-1' });
});

describe('POST /api/internal-agents/:id/runs/:invocationId/rerun', () => {
  it('relays TR 202 accept and forwards (tenantId, internalAgentId, invocationId)', async () => {
    mockRerun.mockResolvedValue({ status: 202, body: { accepted: true } });
    const res = await post();
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ accepted: true });
    // A re-run is a NEW human action, so the member who clicked is this run's
    // trigger; rerun_of_invocation_id carries the lineage back to the failure.
    expect(mockRerun).toHaveBeenCalledWith(TENANT, AGENT, INV, 'account-1');
  });

  it('forwards no actor when the caller resolves to no account', async () => {
    mockGetByFirebaseUid.mockResolvedValue(null);
    mockRerun.mockResolvedValue({ status: 202, body: { accepted: true } });
    const res = await post();
    expect(res.status).toBe(202);
    expect(mockRerun).toHaveBeenCalledWith(TENANT, AGENT, INV, undefined);
  });

  it("relays TR 422 not_re_runnable", async () => {
    mockRerun.mockResolvedValue({ status: 422, body: { error: 'not_re_runnable', reason: 'Only failed runs can be re-run' } });
    const res = await post();
    expect(res.status).toBe(422);
    expect(res.body).toEqual({ error: 'not_re_runnable', reason: 'Only failed runs can be re-run' });
  });

  it('404 when the agent does not exist for the tenant', async () => {
    mockGetById.mockResolvedValue(null);
    const res = await post();
    expect(res.status).toBe(404);
    expect(mockRerun).not.toHaveBeenCalled();
  });

  it('400 when tenantId is missing', async () => {
    mockRerun.mockResolvedValue({ status: 202, body: { accepted: true } });
    const res = await request(buildApp()).post(`/api/internal-agents/${AGENT}/runs/${INV}/rerun`);
    expect(res.status).toBe(400);
    expect(mockRerun).not.toHaveBeenCalled();
  });
});
