// A2A Agent Card Router — unit tests
// Covers: list all agents, single agent card, 404 for unknown/cross-tenant agent,
// valid Agent Card shape, skills from the skills column, tenant-membership enforcement.

import express, { Request, Response, NextFunction } from 'express';

// ── Mocks ──────────────────────────────────────────────────────────────────

const mockPoolQuery = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  getPool: jest.fn(() => ({ query: mockPoolQuery })),
  // Per H1 RLS hardening: agent-card-router runs reads under withTenantScope.
  // The test mock delegates to the same mockPoolQuery so existing assertions
  // continue to work — the client passed to the callback exposes only
  // `query`, which is all the router uses.
  withTenantScope: jest.fn(
    async (
      _tenantId: string,
      fn: (client: { query: typeof mockPoolQuery }) => Promise<unknown>,
    ) => fn({ query: mockPoolQuery }),
  ),
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

// BLK-1 mocks: account lookup + membership lookup. Default behaviour =
// caller is a member of TENANT_ID. Individual tests can override.
const mockGetByFirebaseUid = jest.fn();
const mockGetMembership = jest.fn();

jest.mock('../../accounts/service', () => ({
  AccountService: jest.fn().mockImplementation(() => ({
    getByFirebaseUid: mockGetByFirebaseUid,
  })),
}));

jest.mock('../../tenant-members', () => ({
  tenantMembersService: {
    getMembership: mockGetMembership,
  },
}));

import { agentCardRouter } from '../agent-card-router';

// ── Test app ───────────────────────────────────────────────────────────────

const DEFAULT_FIREBASE_UID = 'firebase-uid-tenant-a-member';

// Sentinel: pass NO_USER explicitly to suppress the user-stub middleware.
// Cannot use `undefined` here because a TS default arg fires when the
// caller passes `undefined` — the default would silently re-attach the
// user, masking the "no Firebase user" test.
const NO_USER = Symbol('no-user');

function buildApp(firebaseUid: string | typeof NO_USER = DEFAULT_FIREBASE_UID) {
  const app = express();
  app.use(express.json());
  // Stub authMiddleware — in production this is mounted globally before /api/a2a.
  app.use((req: Request, _res: Response, next: NextFunction) => {
    if (firebaseUid !== NO_USER) {
      (req as Request & { user?: { uid: string } }).user = { uid: firebaseUid };
    }
    next();
  });
  app.use('/api/a2a', agentCardRouter);
  return app;
}

function makeRequest(
  app: express.Express,
  path: string,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const server = app.listen(0, () => {
      const addr = server.address() as { port: number };
      fetch(`http://127.0.0.1:${addr.port}${path}`)
        .then(async (res) => {
          const b = await res.json().catch(() => ({}));
          server.close();
          resolve({ status: res.status, body: b as Record<string, unknown> });
        })
        .catch((err) => { server.close(); reject(err); });
    });
  });
}

// ── Fixtures ───────────────────────────────────────────────────────────────

const TENANT_ID = '11111111-1111-1111-1111-111111111111';
const AGENT_ID = '22222222-2222-2222-2222-222222222222';

// Mirrors the real `internal_agents` columns the router selects. The previous
// fixture carried a `capabilities` array, which the table has never had — so
// the query could throw against the real table while these tests passed.
// See migrations/__tests__/internal_agents_column_contract.integration.test.ts.
const agentRow = {
  id: AGENT_ID,
  role: 'HR Agent',
  summary: 'Handles HR tasks',
  responsibilities: 'Manage employee records',
  skills: [
    { id: 'skill-payroll', name: 'payroll', description: 'Run the payroll cycle', instruction: '...', tags: ['hr'] },
    { id: 'skill-benefits', name: 'benefits', description: 'Administer benefits', instruction: '...' },
  ],
};

// ── Setup ──────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  // BACKEND_URL is required by getBackendUrl() — use the dev alias to satisfy
  // the cross-env trust guard (test NODE_ENV would reject the prod alias).
  process.env.BACKEND_URL = 'https://api-dev.example.com';
  const m = jest.requireActual('../../infrastructure/control-plane-url') as { _resetBackendUrlCacheForTests: () => void };
  m._resetBackendUrlCacheForTests();
  // Default: caller is account 'acct-a' and is a member of TENANT_ID.
  mockGetByFirebaseUid.mockResolvedValue({ id: 'acct-a' });
  mockGetMembership.mockResolvedValue({ tenantId: TENANT_ID, accountId: 'acct-a', role: 'member' });
});

// ── GET /api/a2a/agents ────────────────────────────────────────────────────

describe('GET /api/a2a/agents', () => {
  it('returns list of Agent Cards for active agents in tenant', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [agentRow] });
    const app = buildApp();
    const res = await makeRequest(app, `/api/a2a/agents?tenantId=${TENANT_ID}`);

    expect(res.status).toBe(200);
    const agents = (res.body as { agents?: unknown[] }).agents;
    expect(agents).toHaveLength(1);
  });

  it('returns valid Agent Card shape', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [agentRow] });
    const app = buildApp();
    const res = await makeRequest(app, `/api/a2a/agents?tenantId=${TENANT_ID}`);

    const card = ((res.body as { agents?: Record<string, unknown>[] }).agents?.[0]) ?? {};
    expect(card.name).toBe('HR Agent');
    expect(card.description).toBe('Handles HR tasks');
    expect(card.version).toBe('1.0.0');
    expect(Array.isArray((card as { supportedInterfaces?: unknown[] }).supportedInterfaces)).toBe(true);
    expect((card as { capabilities?: { streaming?: boolean } }).capabilities?.streaming).toBe(false);
  });

  it('populates skills from the agent skills column', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [agentRow] });
    const app = buildApp();
    const res = await makeRequest(app, `/api/a2a/agents?tenantId=${TENANT_ID}`);

    const card = ((res.body as {
      agents?: { skills?: { id: string; name: string; description: string; tags: string[] }[] }[]
    }).agents?.[0]) ?? {};
    expect(card.skills).toHaveLength(2);
    // Each skill carries its own name, description and tags rather than one
    // string repeated into all three fields.
    expect(card.skills?.[0]).toEqual({
      id: 'skill-payroll',
      name: 'payroll',
      description: 'Run the payroll cycle',
      tags: ['hr'],
    });
    expect(card.skills?.[1].id).toBe('skill-benefits');
    expect(card.skills?.[1].tags).toEqual([]);
  });

  it('omits archived skills from the card', async () => {
    // Archived skills stay in the authoritative column but are not part of what
    // the team member currently advertises it can do.
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{
        ...agentRow,
        skills: [
          ...agentRow.skills,
          { id: 'skill-old', name: 'retired', description: 'no longer offered', instruction: '...', archived: true },
        ],
      }],
    });
    const app = buildApp();
    const res = await makeRequest(app, `/api/a2a/agents?tenantId=${TENANT_ID}`);

    const card = ((res.body as { agents?: { skills?: { name: string }[] }[] }).agents?.[0]) ?? {};
    expect(card.skills?.map((s) => s.name)).toEqual(['payroll', 'benefits']);
  });

  it('falls back to a positional skill id when a skill has none', async () => {
    // Legacy rows predate skill ids. A card skill still needs a stable id.
    mockPoolQuery.mockResolvedValueOnce({
      rows: [{ ...agentRow, skills: [{ name: 'intake', description: 'Triage requests', instruction: '...' }] }],
    });
    const app = buildApp();
    const res = await makeRequest(app, `/api/a2a/agents?tenantId=${TENANT_ID}`);

    const card = ((res.body as { agents?: { skills?: { id: string }[] }[] }).agents?.[0]) ?? {};
    expect(card.skills?.[0].id).toBe(`${AGENT_ID}:0`);
  });

  it('selects only columns that exist on internal_agents', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [agentRow] });
    const app = buildApp();
    await makeRequest(app, `/api/a2a/agents?tenantId=${TENANT_ID}`);

    // The live-schema version of this check is the column-contract integration
    // test; this one keeps two column names that do not exist from coming
    // back in a mocked-pool test that could not notice.
    const sql = String(mockPoolQuery.mock.calls[0][0]);
    expect(sql).not.toMatch(/\bcapabilities\b/);
    expect(sql).not.toMatch(/\blifecycle\b/);
    expect(sql).toMatch(/status = 'active'/);
  });

  it('returns 400 when tenantId is missing', async () => {
    const app = buildApp();
    const res = await makeRequest(app, '/api/a2a/agents');
    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid tenantId format', async () => {
    const app = buildApp();
    const res = await makeRequest(app, '/api/a2a/agents?tenantId=not-a-uuid');
    expect(res.status).toBe(400);
  });

  it('returns empty list when no active agents', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    const app = buildApp();
    const res = await makeRequest(app, `/api/a2a/agents?tenantId=${TENANT_ID}`);
    expect(res.status).toBe(200);
    expect((res.body as { agents?: unknown[] }).agents).toHaveLength(0);
  });
});

// ── GET /api/a2a/agents/:agentId/card ─────────────────────────────────────

describe('GET /api/a2a/agents/:agentId/card', () => {
  it('returns Agent Card for active agent in tenant', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [agentRow] });
    const app = buildApp();
    const res = await makeRequest(app, `/api/a2a/agents/${AGENT_ID}/card?tenantId=${TENANT_ID}`);

    expect(res.status).toBe(200);
    expect((res.body as { name?: string }).name).toBe('HR Agent');
  });

  it('returns 404 for archived (deleted) agent', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // status != active or deleted_at set
    const app = buildApp();
    const res = await makeRequest(app, `/api/a2a/agents/${AGENT_ID}/card?tenantId=${TENANT_ID}`);
    expect(res.status).toBe(404);
  });

  it('returns 404 for agent in different tenant', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [] }); // tenant_id filter excludes it
    const otherTenantId = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
    const app = buildApp();
    const res = await makeRequest(app, `/api/a2a/agents/${AGENT_ID}/card?tenantId=${otherTenantId}`);
    expect(res.status).toBe(404);
  });

  it('returns 400 for invalid agentId format', async () => {
    const app = buildApp();
    const res = await makeRequest(app, `/api/a2a/agents/not-a-uuid/card?tenantId=${TENANT_ID}`);
    expect(res.status).toBe(400);
  });

  it('RPC URL in supportedInterfaces contains agentId', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [agentRow] });
    const app = buildApp();
    const res = await makeRequest(app, `/api/a2a/agents/${AGENT_ID}/card?tenantId=${TENANT_ID}`);

    const ifaces = (res.body as { supportedInterfaces?: { url: string }[] }).supportedInterfaces;
    expect(ifaces?.[0].url).toContain(AGENT_ID);
  });
});

// ── BLK-1: cross-tenant tenantId spoofing ──────────────────────────────────
//
// An authenticated user from tenant A must NOT be able to read tenant B's
// agents by passing tenantId=tenantB in the query string. Membership is
// checked server-side via tenantMembersService.getMembership.

describe('BLK-1: tenant-membership enforcement', () => {
  const TENANT_B = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';

  it('list: returns 403 when caller is not a member of the requested tenant', async () => {
    mockGetMembership.mockResolvedValueOnce(null); // not a member of tenant B
    const app = buildApp();
    const res = await makeRequest(app, `/api/a2a/agents?tenantId=${TENANT_B}`);

    expect(res.status).toBe(403);
    expect(mockGetMembership).toHaveBeenCalledWith(TENANT_B, 'acct-a');
    // Critical: the DB query must NOT have run.
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('single card: returns 403 when caller is not a member of the requested tenant', async () => {
    mockGetMembership.mockResolvedValueOnce(null);
    const app = buildApp();
    const res = await makeRequest(app, `/api/a2a/agents/${AGENT_ID}/card?tenantId=${TENANT_B}`);

    expect(res.status).toBe(403);
    expect(mockGetMembership).toHaveBeenCalledWith(TENANT_B, 'acct-a');
    expect(mockPoolQuery).not.toHaveBeenCalled();
  });

  it('returns 401 when no Firebase user is on the request', async () => {
    const app = buildApp(NO_USER);
    const res = await makeRequest(app, `/api/a2a/agents?tenantId=${TENANT_ID}`);
    expect(res.status).toBe(401);
  });

  it('returns 401 when Firebase UID does not resolve to an account', async () => {
    mockGetByFirebaseUid.mockResolvedValueOnce(null);
    const app = buildApp();
    const res = await makeRequest(app, `/api/a2a/agents?tenantId=${TENANT_ID}`);
    expect(res.status).toBe(401);
  });
});
