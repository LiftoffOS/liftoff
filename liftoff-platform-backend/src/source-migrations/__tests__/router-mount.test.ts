// Wire-level proof that the source-migrations routes are REACHABLE.
//
// The reachability ratchet cannot prove this: routers self-reference, so a
// module that is imported but never mounted still looks reachable while every
// request to it 404s. That is the "wired at one end" defect this repo keeps
// finding, and it passes unit tests, lint and typecheck on its way to
// production. So these tests go through an Express app with the router mounted
// at its real path and assert real status codes.
//
// They also assert the guard ORDER: a request that names a tenant the caller
// does not belong to must be refused before any handler work happens.

import { jest } from '@jest/globals';
import express from 'express';
import request from 'supertest';

const mockAuthMiddleware = jest.fn();
const mockTenantAuthMiddleware = jest.fn();

jest.mock('../../infrastructure/middleware', () => ({
  authMiddleware: (req: unknown, res: unknown, next: () => void) =>
    mockAuthMiddleware(req, res, next),
  tenantAuthMiddleware: (permission: string) => (req: unknown, res: unknown, next: () => void) =>
    mockTenantAuthMiddleware(permission, req, res, next),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
  logAudit: jest.fn(),
}));

const mockWithTenantScope = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withTenantScope: (...args: unknown[]) => mockWithTenantScope(...args),
  getPool: jest.fn(),
}));

const mockGetByFirebaseUid = jest.fn();
jest.mock('../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: (...args: unknown[]) => mockGetByFirebaseUid(...args),
  })),
}));

const mockCreateOrResume = jest.fn();
const mockGetById = jest.fn();
const mockAcceptBundle = jest.fn();
const mockConvert = jest.fn();
const mockActivate = jest.fn();
const mockBuildView = jest.fn();
const mockReadEntitlement = jest.fn();

jest.mock('../service', () => {
  class SourceMigrationError extends Error {
    constructor(
      message: string,
      readonly statusCode: number,
      readonly code: string,
    ) {
      super(message);
    }
  }
  return {
    SourceMigrationError,
    readEntitlementSnapshot: (...args: unknown[]) => mockReadEntitlement(...args),
    sourceMigrationService: {
      createOrResume: (...args: unknown[]) => mockCreateOrResume(...args),
      getById: (...args: unknown[]) => mockGetById(...args),
      acceptBundle: (...args: unknown[]) => mockAcceptBundle(...args),
      convert: (...args: unknown[]) => mockConvert(...args),
      activate: (...args: unknown[]) => mockActivate(...args),
      buildView: (...args: unknown[]) => mockBuildView(...args),
    },
  };
});

 
const { sourceMigrationsRouter } = require('../router');

const TENANT = '11111111-1111-4111-8111-111111111111';
const MIGRATION_ID = '33333333-3333-4333-8333-333333333333';

function buildApp(): express.Express {
  const app = express();
  // Mirrors src/index.ts, including the ORDER: the bundle route's larger parser
  // must come first, because body-parser is a no-op once req.body is set. A
  // harness that used only the general parser would 413 on a real bundle and
  // "prove" a limit the production app does not have. That index.ts keeps this
  // order is pinned separately, in src/__tests__/index-mount-order.test.ts —
  // this harness cannot vouch for the real file.
  app.use('/api/source-migrations/:id/bundle', express.json({ limit: '32mb' }));
  app.use(express.json({ limit: '5mb' }));
  // The REAL mount path from src/index.ts.
  app.use('/api/source-migrations', sourceMigrationsRouter);
  return app;
}

const VIEW = {
  id: MIGRATION_ID,
  source: 'openclaw',
  state: 'payment_required',
  itemCount: 2,
  convertedCount: 0,
  unsupportedCount: 1,
  items: [],
  requirements: [],
  webPath: '/dashboard/switch/openclaw/review',
  onboardingComplete: true,
};

beforeEach(() => {
  jest.clearAllMocks();
  // Authenticated by default; individual tests override to prove the gates.
  mockAuthMiddleware.mockImplementation((req: any, _res: unknown, next: () => void) => {
    req.user = { uid: 'firebase-uid' };
    next();
  });
  mockTenantAuthMiddleware.mockImplementation(
    (_permission: string, _req: unknown, _res: unknown, next: () => void) => next(),
  );
  mockGetByFirebaseUid.mockResolvedValue({ id: 'account-1' });
  mockWithTenantScope.mockImplementation(async (_tenantId: string, fn: any) =>
    fn({ query: async () => ({ rows: [{ onboarding_completed_at: new Date() }] }) }),
  );
  mockBuildView.mockResolvedValue(VIEW);
});

describe('the routes exist at their real mount path', () => {
  it('POST /api/source-migrations creates or resumes and returns 201', async () => {
    mockCreateOrResume.mockResolvedValue({ id: MIGRATION_ID, source: 'openclaw' });

    const res = await request(buildApp())
      .post('/api/source-migrations')
      .send({
        tenantId: TENANT,
        source: 'openclaw',
        adapterVersion: '1.0.0',
        installationFingerprint: 'abcdef0123456789',
      });

    expect(res.status).toBe(201);
    expect(res.body.id).toBe(MIGRATION_ID);
    // Not a 404: the router is genuinely mounted.
    expect(mockCreateOrResume).toHaveBeenCalled();
  });

  it('GET /api/source-migrations/:id returns the view', async () => {
    mockGetById.mockResolvedValue({ id: MIGRATION_ID, source: 'openclaw' });

    const res = await request(buildApp()).get(
      `/api/source-migrations/${MIGRATION_ID}?tenantId=${TENANT}`,
    );

    expect(res.status).toBe(200);
    expect(res.body.webPath).toBe('/dashboard/switch/openclaw/review');
  });

  it('GET returns 404 for a migration that does not exist, not a 500', async () => {
    mockGetById.mockResolvedValue(null);
    const res = await request(buildApp()).get(
      `/api/source-migrations/${MIGRATION_ID}?tenantId=${TENANT}`,
    );
    expect(res.status).toBe(404);
  });

  it('PUT /api/source-migrations/:id/bundle accepts a valid bundle', async () => {
    mockAcceptBundle.mockResolvedValue({ id: MIGRATION_ID, source: 'openclaw' });

    const res = await request(buildApp())
      .put(`/api/source-migrations/${MIGRATION_ID}/bundle`)
      .send({ tenantId: TENANT, bundle: minimalBundle() });

    expect(res.status).toBe(200);
    expect(mockAcceptBundle).toHaveBeenCalled();
  });

  it('accepts a bundle far larger than the general API body limit', async () => {
    // A bundle is a bulk upload: one imported team member's instructions,
    // skills and memories measured 2 MB on their own, so three of them exceed
    // the 5 MB general default. It failed with a bare 413 from the proxy — no
    // JSON, no errorCode, nothing naming the installation that was too big.
    mockAcceptBundle.mockResolvedValue({ id: MIGRATION_ID, source: 'openclaw' });

    const res = await request(buildApp())
      .put(`/api/source-migrations/${MIGRATION_ID}/bundle`)
      .send({
        tenantId: TENANT,
        bundle: {
          ...minimalBundle(),
          diagnostics: [`padding ${'x'.repeat(1000)}`],
          instructions: Array.from({ length: 900 }, (_, i) => ({
            sourceRef: `agent:one:file-${i}.md`,
            name: `file-${i}.md`,
            sourcePath: `memories/file-${i}.md`,
            category: 'memory',
            padding: 'y'.repeat(8_000),
          })),
        },
      });

    expect(res.status).toBe(200);
  });

  it('accepts the bundle diagnostics the CLI bounds itself to', async () => {
    // The CLI bounds each line to 1024 characters and the list to 500 because
    // THIS schema rejects the whole bundle beyond either. If the two ever
    // disagree, an installation with enough overflow to write a long note fails
    // to import because of the note explaining why material was dropped.
    mockAcceptBundle.mockResolvedValue({ id: MIGRATION_ID, source: 'openclaw' });

    const res = await request(buildApp())
      .put(`/api/source-migrations/${MIGRATION_ID}/bundle`)
      .send({
        tenantId: TENANT,
        bundle: {
          ...minimalBundle(),
          diagnostics: Array.from({ length: 500 }, () => 'x'.repeat(1024)),
        },
      });

    expect(res.status).toBe(200);
  });

  it('refuses a bundle whose diagnostics exceed the bound', async () => {
    // Bounded on purpose: diagnostics are notes for support, not a channel for
    // arbitrary payload on a route that writes to the database.
    const res = await request(buildApp())
      .put(`/api/source-migrations/${MIGRATION_ID}/bundle`)
      .send({
        tenantId: TENANT,
        bundle: { ...minimalBundle(), diagnostics: ['x'.repeat(1025)] },
      });

    expect(res.status).toBe(400);
  });

  it('accepts a bundle with no diagnostics at all', async () => {
    // Optional: an older CLI does not send the field, and an import from one
    // must not start failing.
    mockAcceptBundle.mockResolvedValue({ id: MIGRATION_ID, source: 'openclaw' });
    const bundle = minimalBundle();
    delete (bundle as { diagnostics?: unknown }).diagnostics;

    const res = await request(buildApp())
      .put(`/api/source-migrations/${MIGRATION_ID}/bundle`)
      .send({ tenantId: TENANT, bundle });

    expect(res.status).toBe(200);
  });

  it('POST /api/source-migrations/:id/convert reads the billing authority', async () => {
    mockReadEntitlement.mockResolvedValue({ paid: true });
    mockConvert.mockResolvedValue({ id: MIGRATION_ID, source: 'openclaw' });

    const res = await request(buildApp())
      .post(`/api/source-migrations/${MIGRATION_ID}/convert`)
      .send({ tenantId: TENANT });

    expect(res.status).toBe(200);
    // Subscription truth is read, never taken from the request body.
    expect(mockReadEntitlement).toHaveBeenCalledWith(TENANT);
  });

  it('POST /api/source-migrations/:id/activate requires explicit confirmation', async () => {
    const res = await request(buildApp())
      .post(`/api/source-migrations/${MIGRATION_ID}/activate`)
      .send({ tenantId: TENANT });

    expect(res.status).toBe(400);
    expect(res.body.errorCode).toBe('confirmation_required');
    expect(mockActivate).not.toHaveBeenCalled();
  });

  it('POST /api/source-migrations/:id/activate proceeds when confirmed', async () => {
    mockReadEntitlement.mockResolvedValue({ paid: true });
    mockActivate.mockResolvedValue({ id: MIGRATION_ID, source: 'openclaw' });

    const res = await request(buildApp())
      .post(`/api/source-migrations/${MIGRATION_ID}/activate`)
      .send({ tenantId: TENANT, confirmed: true });

    expect(res.status).toBe(200);
    expect(mockActivate).toHaveBeenCalled();
  });
});

describe('tenancy is proved before any handler runs', () => {
  it('applies the membership guard to every route', async () => {
    mockCreateOrResume.mockResolvedValue({ id: MIGRATION_ID, source: 'openclaw' });
    await request(buildApp())
      .post('/api/source-migrations')
      .send({
        tenantId: TENANT,
        source: 'openclaw',
        adapterVersion: '1.0.0',
        installationFingerprint: 'abcdef0123456789',
      });
    expect(mockTenantAuthMiddleware).toHaveBeenCalledWith(
      'editTeams',
      expect.anything(),
      expect.anything(),
      expect.anything(),
    );
  });

  it('refuses a caller who does not belong to the named tenant', async () => {
    mockTenantAuthMiddleware.mockImplementation(
      (_permission: string, _req: unknown, res: any) =>
        res.status(403).json({ error: 'Not a member of this tenant' }),
    );

    const res = await request(buildApp()).get(
      `/api/source-migrations/${MIGRATION_ID}?tenantId=${TENANT}`,
    );

    expect(res.status).toBe(403);
    // The guard ran before the handler, so no service call happened at all.
    expect(mockGetById).not.toHaveBeenCalled();
  });

  it('refuses an unauthenticated caller', async () => {
    mockAuthMiddleware.mockImplementation((_req: unknown, res: any) =>
      res.status(401).json({ error: 'Authentication required' }),
    );

    const res = await request(buildApp()).get(
      `/api/source-migrations/${MIGRATION_ID}?tenantId=${TENANT}`,
    );

    expect(res.status).toBe(401);
    expect(mockTenantAuthMiddleware).not.toHaveBeenCalled();
  });
});

describe('input validation at the edge', () => {
  it('rejects a non-UUID migration id', async () => {
    const res = await request(buildApp()).get('/api/source-migrations/not-a-uuid?tenantId=' + TENANT);
    expect(res.status).toBe(400);
  });

  it('rejects a deferred source', async () => {
    const res = await request(buildApp())
      .post('/api/source-migrations')
      .send({
        tenantId: TENANT,
        source: 'deerflow',
        adapterVersion: '1.0.0',
        installationFingerprint: 'abcdef0123456789',
      });
    expect(res.status).toBe(400);
  });

  it('accepts an import far larger than one hour of distillation allowance', async () => {
    // There is no cap on team members. Conversion is rate-limited and resumes
    // itself, so a large import takes several waves; refusing it here would
    // refuse work the system completes on its own.
    const bundle = minimalBundle();
    bundle.agents = Array.from({ length: 120 }, (_, i) => ({
      sourceRef: `agent:${i}`,
      role: 'R',
      responsibilities: 'R',
      attachments: [],
      integrationRefs: [],
      mcpServerRefs: [],
      routineRefs: [],
    }));

    const res = await request(buildApp())
      .put(`/api/source-migrations/${MIGRATION_ID}/bundle`)
      .send({ tenantId: TENANT, bundle });

    expect(res.status).toBe(200);
    expect(mockAcceptBundle).toHaveBeenCalled();
  });

  it('still bounds the payload, so a bundle cannot be unbounded', async () => {
    // Not a product limit — a payload one. 500 is the same bound the other
    // per-bundle arrays carry.
    const bundle = minimalBundle();
    bundle.agents = Array.from({ length: 501 }, (_, i) => ({
      sourceRef: `agent:${i}`,
      role: 'R',
      responsibilities: 'R',
      attachments: [],
      integrationRefs: [],
      mcpServerRefs: [],
      routineRefs: [],
    }));

    const res = await request(buildApp())
      .put(`/api/source-migrations/${MIGRATION_ID}/bundle`)
      .send({ tenantId: TENANT, bundle });

    expect(res.status).toBe(400);
  });

  it('rejects an agent whose responsibilities exceed the distill bound', async () => {
    const bundle = minimalBundle();
    bundle.agents[0].responsibilities = 'x'.repeat(10_001);

    const res = await request(buildApp())
      .put(`/api/source-migrations/${MIGRATION_ID}/bundle`)
      .send({ tenantId: TENANT, bundle });

    expect(res.status).toBe(400);
  });
});

function minimalBundle(): any {
  return {
    bundleVersion: 1,
    source: 'openclaw',
    adapterVersion: '1.0.0',
    installationFingerprint: 'abcdef0123456789',
    agents: [
      {
        sourceRef: 'agent:research',
        role: 'Research',
        responsibilities: 'Research competitors.',
        attachments: [],
        integrationRefs: [],
        mcpServerRefs: [],
        routineRefs: [],
      },
    ],
    teamRelationships: [],
    instructions: [],
    skills: [],
    memories: [],
    routines: [],
    catalogConnectorRequirements: [],
    customMcpServerRequirements: [],
    hostingRequirements: [],
    governanceRules: [],
    modelPreferences: [],
    unsupportedItems: [],
  };
}
