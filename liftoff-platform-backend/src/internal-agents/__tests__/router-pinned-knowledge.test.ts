// Integration tests for the POST/PUT pinned-knowledge wiring in internal-agents
// router. Covers the spec cases from plan §1.8:
//   - POST with marker + bound connector → pinnedKnowledgeIds persisted
//   - POST with marker + unbound connector → silent filter to []
//   - POST with manual URL marker (connectorId null) → always allowed
//   - POST with no markers → pinnedKnowledgeIds = []
//   - POST with marker for missing item → silent filter to []
//   - PUT integrations-only patch that orphans an existing pin → orphan filtered
//   - PUT 404 when agent doesn't exist
//
// Heavy services are mocked; the focus is the router-level marker-parse and
// filter logic introduced by parseAndFilterPinnedKnowledge.

import express from 'express';
import request from 'supertest';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockCreate = jest.fn();
const mockUpdate = jest.fn();
const mockGetById = jest.fn();
const mockFindByIds = jest.fn();

jest.mock('../service', () => ({
  internalAgentService: {
    create: (...args: unknown[]) => mockCreate(...args),
    update: (...args: unknown[]) => mockUpdate(...args),
    getById: (...args: unknown[]) => mockGetById(...args),
  },
}));

jest.mock('../../knowledge/repository', () => ({
  findByIds: (...args: unknown[]) => mockFindByIds(...args),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

jest.mock('../../infrastructure/idempotency', () => ({
  withIdempotency: jest.fn(async (_t: string, _k: string, _e: string, _h: string, fn: () => Promise<unknown>) => {
    const result = await fn() as { status: number; body: unknown };
    return { cached: false, status: result.status, response: result.body };
  }),
}));

jest.mock('../../infrastructure/idempotency-middleware', () => ({
  withIdempotencyMiddleware: () => (_req: unknown, _res: unknown, next: () => void) => next(),
}));

jest.mock('../../infrastructure/audit-context', () => ({ auditCtx: () => ({}) }));

// These two mocks now also feed `verifyTenantOwnership`, which guards every
// route under test. It resolves the caller's account from req.ctx.userId and
// requires a membership row for the tenant named in the request — so a null
// account or an empty members service makes every case here 401/403 before the
// handler runs. The values below are the ordinary case: a real account that
// belongs to the tenant it is acting on.
jest.mock('../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: jest.fn(async () => ({ id: 'acct-1' })),
  })),
}));
jest.mock('../../accounts/repository', () => ({ AccountRepository: jest.fn() }));
jest.mock('../../tenant-members/service', () => ({
  tenantMembersService: {
    getMembership: jest.fn(async () => ({ role: 'admin', accountId: 'acct-1' })),
  },
}));
jest.mock('../../llm/usage-tracker', () => ({ attributeSessionToAgent: jest.fn() }));
jest.mock('../../connectors/tenant-runtime-client', () => ({ tenantRuntimeClient: {} }));
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
  // verifyServiceAuth is used as a middleware factory by the workforce-service
  // service-token route (router.ts:54). Return a passthrough middleware so the
  // module loads without Express throwing "callback function but got Boolean".
  verifyServiceAuth: jest.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));
jest.mock('../../infrastructure/scheduler-auth', () => ({
  // requireSchedulerOidc is a middleware factory (router.ts:195). Return a
  // passthrough middleware so the module loads without crashing.
  requireSchedulerOidc: jest.fn(() => (_req: unknown, _res: unknown, next: () => void) => next()),
}));

// Disable rate limiter so the test doesn't depend on header/IP shape.
jest.mock('express-rate-limit', () => () => (_req: unknown, _res: unknown, next: () => void) => next());

import { internalAgentsRouter } from '../router';

function buildApp(): express.Express {
  const app = express();
  app.use(express.json());
  // Pre-populate req.ctx to satisfy handlers that check req.ctx?.userId
  app.use((req, _res, next) => {
    (req as any).ctx = { userId: 'u-1', tenantId: 't-1' };
    (req as any).isPlatformAdmin = true; // bypass admin gate on modelConfig
    next();
  });
  app.use('/api/internal-agents', internalAgentsRouter);
  return app;
}

const TENANT = 't-1';
// integration-validator (post-update) requires connector ids to be valid
// UUIDs; literal strings like 'c-bound' now ZodError out at the boundary.
const CONNECTOR_BOUND = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const CONNECTOR_UNBOUND = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
// Real UUIDs — parseAndFilterPinnedKnowledge filters non-UUID id slots before
// they reach findByIds (defense against PG "invalid input syntax for type uuid").
const PIN_ID_BOUND = '11111111-1111-4111-8111-111111111111';
const PIN_ID_UNBOUND = '22222222-2222-4222-8222-222222222222';
const PIN_ID_MANUAL = '33333333-3333-4333-8333-333333333333';
const PIN_ID_MISSING = '44444444-4444-4444-8444-444444444444';

beforeEach(() => {
  jest.clearAllMocks();
  // Default: create returns a synthetic agent
  mockCreate.mockImplementation(async (_tid: string, input: { role: string; pinnedKnowledgeIds?: string[] }) => ({
    id: 'agent-1', tenantId: TENANT, role: input.role,
    pinnedKnowledgeIds: input.pinnedKnowledgeIds ?? [],
  }));
  mockUpdate.mockImplementation(async (_aid: string, _tid: string, input: { pinnedKnowledgeIds?: string[] }) => ({
    id: 'agent-1', tenantId: TENANT, role: 'r',
    pinnedKnowledgeIds: input.pinnedKnowledgeIds ?? [],
  }));
  // findByIds default: return all pin items with the right connectorId mapping
  mockFindByIds.mockImplementation(async (_t: string, ids: string[]) => {
    const all = [
      { id: PIN_ID_BOUND, title: 'Bound', sourceUrl: null, connectorId: CONNECTOR_BOUND },
      { id: PIN_ID_UNBOUND, title: 'Unbound', sourceUrl: null, connectorId: CONNECTOR_UNBOUND },
      { id: PIN_ID_MANUAL, title: 'Manual', sourceUrl: 'https://x', connectorId: null },
    ];
    return all.filter(i => ids.includes(i.id));
  });
});

describe('POST /api/internal-agents — pinnedKnowledgeIds wiring', () => {
  it('persists pinnedKnowledgeIds when marker is bound', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/internal-agents?tenantId=' + TENANT)
      .send({
        role: 'Agent',
        responsibilities: `See [[knowledge:${PIN_ID_BOUND}:Bound]]`,
        integrations: [{ id: CONNECTOR_BOUND, selectedObjects: [] }],
      })
      .expect(201);

    const createInput = mockCreate.mock.calls[0][1];
    expect(createInput.pinnedKnowledgeIds).toEqual([PIN_ID_BOUND]);
  });

  it('silently filters pin when connector not bound', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/internal-agents?tenantId=' + TENANT)
      .send({
        role: 'Agent',
        responsibilities: `See [[knowledge:${PIN_ID_UNBOUND}:Unbound]]`,
        integrations: [{ id: CONNECTOR_BOUND, selectedObjects: [] }],
      })
      .expect(201);

    expect(mockCreate.mock.calls[0][1].pinnedKnowledgeIds).toEqual([]);
  });

  it('always allows manual-URL pins (connectorId null)', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/internal-agents?tenantId=' + TENANT)
      .send({
        role: 'Agent',
        responsibilities: `See [[knowledge:${PIN_ID_MANUAL}:Manual]]`,
        integrations: [],
      })
      .expect(201);

    expect(mockCreate.mock.calls[0][1].pinnedKnowledgeIds).toEqual([PIN_ID_MANUAL]);
  });

  it('defaults to [] when no markers in prose', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/internal-agents?tenantId=' + TENANT)
      .send({
        role: 'Agent',
        responsibilities: 'plain text',
        integrations: [{ id: CONNECTOR_BOUND, selectedObjects: [] }],
      })
      .expect(201);

    expect(mockCreate.mock.calls[0][1].pinnedKnowledgeIds).toEqual([]);
  });

  it('silently filters pins whose knowledge_item no longer exists', async () => {
    const app = buildApp();
    await request(app)
      .post('/api/internal-agents?tenantId=' + TENANT)
      .send({
        role: 'Agent',
        responsibilities: `See [[knowledge:${PIN_ID_MISSING}:Gone]]`,
        integrations: [{ id: CONNECTOR_BOUND, selectedObjects: [] }],
      })
      .expect(201);

    expect(mockCreate.mock.calls[0][1].pinnedKnowledgeIds).toEqual([]);
  });
});

describe('PUT /api/internal-agents/:id — pin re-validation', () => {
  it('returns 404 when agent does not exist', async () => {
    mockGetById.mockResolvedValueOnce(null);
    const app = buildApp();
    await request(app)
      .put('/api/internal-agents/agent-1?tenantId=' + TENANT)
      .send({ role: 'r' })
      .expect(404);
  });

  it('integrations-only patch that orphans existing pin filters it out', async () => {
    // Existing agent has the bound connector + the pin in its prose.
    mockGetById.mockResolvedValueOnce({
      id: 'agent-1', tenantId: TENANT,
      responsibilities: `See [[knowledge:${PIN_ID_BOUND}:Bound]]`,
      additionalContext: null,
      integrations: [{ id: CONNECTOR_BOUND, selectedObjects: [] }],
      autonomyOverride: null,
      pinnedKnowledgeIds: [PIN_ID_BOUND],
    });
    const app = buildApp();
    await request(app)
      .put('/api/internal-agents/agent-1?tenantId=' + TENANT)
      // Operator removes the connector — prose still mentions the pin.
      .send({ integrations: [] })
      .expect(200);

    expect(mockUpdate.mock.calls[0][2].pinnedKnowledgeIds).toEqual([]);
  });

  it('integrations-only patch keeps still-valid pins', async () => {
    mockGetById.mockResolvedValueOnce({
      id: 'agent-1', tenantId: TENANT,
      responsibilities: `See [[knowledge:${PIN_ID_BOUND}:Bound]]`,
      additionalContext: null,
      integrations: [{ id: CONNECTOR_BOUND, selectedObjects: [] }],
      autonomyOverride: null,
      pinnedKnowledgeIds: [PIN_ID_BOUND],
    });
    const app = buildApp();
    await request(app)
      .put('/api/internal-agents/agent-1?tenantId=' + TENANT)
      .send({ integrations: [{ id: CONNECTOR_BOUND, selectedObjects: [] }] })
      .expect(200);

    expect(mockUpdate.mock.calls[0][2].pinnedKnowledgeIds).toEqual([PIN_ID_BOUND]);
  });
});
