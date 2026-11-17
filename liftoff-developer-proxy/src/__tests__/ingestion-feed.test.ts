// Ingestion feed endpoint tests.
// Uses jest.unstable_mockModule + dynamic import (ESM pattern) to mock DB and
// Secret Manager before the route module is loaded.

import { jest } from '@jest/globals';

// ---------------------------------------------------------------------------
// Shared mock state
// ---------------------------------------------------------------------------

const MOCK_SERVICE_TOKEN = 'test-service-token';

interface FakeRow {
  id: string;
  tenant_id: string;
  agent_id: string | null;
  invocation_id: string | null;
  action_id: string | null;
  vendor: string;
  model: string;
  operation: string | null;
  input_tokens: string;
  output_tokens: string;
  cost_micros: string;
  started_at: Date;
}

let mockRows: FakeRow[] = [];
let capturedSqls: string[] = [];

function makeRow(overrides: Partial<FakeRow> = {}): FakeRow {
  return {
    id: '123',
    tenant_id: 'tenant-uuid-1',
    agent_id: 'agent-abc',
    invocation_id: 'inv-xyz',
    action_id: 'action-123',
    vendor: 'anthropic',
    model: 'claude-opus-4-6',
    operation: 'messages.create',
    input_tokens: '1000',
    output_tokens: '500',
    cost_micros: '25000',
    started_at: new Date('2026-04-25T00:00:00Z'),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Mock modules (must be called before dynamic imports)
// ---------------------------------------------------------------------------

jest.unstable_mockModule('../infrastructure/database.js', () => ({
  getPool: jest.fn(async () => ({
    query: jest.fn(async (sql: string, _params: unknown[]) => {
      capturedSqls.push(sql);
      return { rows: mockRows, rowCount: mockRows.length };
    }),
  })),
  closePool: jest.fn(),
  withByokTenant: jest.fn(),
  withByokUser: jest.fn(),
}));

jest.unstable_mockModule('../infrastructure/config.js', () => ({
  loadConfig: () => ({
    ENVIRONMENT: 'dev',
    GCP_PROJECT_ID: 'test-project',
    GCP_REGION: 'us-west1',
    PORT: 8080,
    DB_INSTANCE_CONNECTION_NAME: 'test:us-west1:test',
    DB_NAME: 'developer_proxy',
    DB_USER: 'developer_proxy_app',
    DB_APP_PASSWORD_SECRET: 'developer-proxy-app-password',
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    PROXY_BASE_URL: 'https://api.example.com/proxy',
    BILLING_SERVICE_URL: '',
    DEVELOPER_PROXY_SERVICE_TOKEN_SECRET: 'developer-proxy-service-token',
    DEVELOPER_PROXY_EVENTS_TOPIC: 'developer-proxy-events',
    OUTBOX_POLL_INTERVAL_MS: 500,
    OUTBOX_BATCH_SIZE: 100,
  }),
  resetConfigForTests: jest.fn(),
}));

jest.unstable_mockModule('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: class {
    accessSecretVersion(_: unknown) {
      return Promise.resolve([{ payload: { data: Buffer.from(MOCK_SERVICE_TOKEN) } }]);
    }
  },
}));

// Mock RPC router (requires proto-gen)
jest.unstable_mockModule('../rpc/router.js', () => ({
  registerRpcRoutes: jest.fn(),
}));

// Mock outbox worker: the feed request is where the outbox is delivered.
const mockDrainOutboxes = jest.fn<() => Promise<void>>().mockResolvedValue(undefined);
jest.unstable_mockModule('../outbox/worker.js', () => ({
  drainOutboxes: mockDrainOutboxes,
}));

// Mock vendor registry (used by proxy routes)
jest.unstable_mockModule('../vendor/registry.js', () => ({
  getAdapter: jest.fn(),
  getVendorConfig: jest.fn(),
  resolveVendorFromRequest: jest.fn(),
}));

// ---------------------------------------------------------------------------
// Dynamic imports (must come after unstable_mockModule)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/consistent-type-imports
type FastifyInstance = import('fastify').FastifyInstance;

let buildApp: () => Promise<FastifyInstance>;

beforeAll(async () => {
  process.env.NODE_ENV = 'test';
  process.env.DEVELOPER_PROXY_SERVICE_TOKEN = MOCK_SERVICE_TOKEN;

  const serverMod = await import('../server.js') as { buildApp: () => Promise<FastifyInstance> };
  buildApp = serverMod.buildApp;
});

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('GET /api/usage/ingestion-feed', () => {
  let app: FastifyInstance;

  beforeEach(async () => {
    mockRows = [];
    capturedSqls = [];
    mockDrainOutboxes.mockClear();
    mockDrainOutboxes.mockResolvedValue(undefined);
    app = await buildApp();
  });

  afterEach(async () => {
    await app.close();
  });

  test('returns 401 when x-service-token header is missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/usage/ingestion-feed?after_id=0',
    });
    expect(res.statusCode).toBe(401);
    const body = res.json<{ error: string }>();
    expect(body.error).toMatch(/x-service-token/i);
  });

  test('returns 401 when x-service-token is wrong', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/usage/ingestion-feed?after_id=0',
      headers: { 'x-service-token': 'wrong-token' },
    });
    expect(res.statusCode).toBe(401);
    const body = res.json<{ error: string }>();
    expect(body.error).toMatch(/invalid/i);
  });

  test('delivers the outbox inside an authorised poll, before it answers', async () => {
    let drained = false;
    mockDrainOutboxes.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 20));
      drained = true;
    });
    const res = await app.inject({
      method: 'GET',
      url: '/api/usage/ingestion-feed?after_id=0',
      headers: { 'x-service-token': MOCK_SERVICE_TOKEN },
    });
    expect(res.statusCode).toBe(200);
    expect(mockDrainOutboxes).toHaveBeenCalledTimes(1);
    expect(drained).toBe(true);
  });

  test('an unauthorised poll delivers nothing', async () => {
    await app.inject({
      method: 'GET',
      url: '/api/usage/ingestion-feed?after_id=0',
      headers: { 'x-service-token': 'wrong-token' },
    });
    expect(mockDrainOutboxes).not.toHaveBeenCalled();
  });

  test('a failed outbox delivery never fails the feed', async () => {
    mockDrainOutboxes.mockRejectedValue(new Error('pubsub down'));
    const res = await app.inject({
      method: 'GET',
      url: '/api/usage/ingestion-feed?after_id=0',
      headers: { 'x-service-token': MOCK_SERVICE_TOKEN },
    });
    expect(res.statusCode).toBe(200);
  });

  test('defaults after_id to 0 when missing', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/usage/ingestion-feed',
      headers: { 'x-service-token': MOCK_SERVICE_TOKEN },
    });
    expect(res.statusCode).toBe(200);
  });

  test('returns 400 when after_id is invalid', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/usage/ingestion-feed?after_id=-1',
      headers: { 'x-service-token': MOCK_SERVICE_TOKEN },
    });
    expect(res.statusCode).toBe(400);
    const body = res.json<{ error: string }>();
    expect(body.error).toMatch(/after_id/i);
  });

  test('returns 200 with rows and hasMore=false when results fit within limit', async () => {
    mockRows = [makeRow()];

    const res = await app.inject({
      method: 'GET',
      url: '/api/usage/ingestion-feed?after_id=0&limit=500',
      headers: { 'x-service-token': MOCK_SERVICE_TOKEN },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      rows: Array<{
        id: string;
        tenantId: string;
        agentId: string | null;
        invocationId: string | null;
        actionId: string | null;
        vendor: string;
        model: string;
        inputTokens: number;
        outputTokens: number;
        costMicros: number;
        startedAt: string;
      }>;
      hasMore: boolean;
      nextAfterId: number;
    }>();

    expect(body.hasMore).toBe(false);
    expect(body.rows).toHaveLength(1);
    const r = body.rows[0];
    expect(r.id).toBe('123');
    expect(r.tenantId).toBe('tenant-uuid-1');
    expect(r.agentId).toBe('agent-abc');
    expect(r.invocationId).toBe('inv-xyz');
    expect(r.actionId).toBe('action-123');
    expect(r.vendor).toBe('anthropic');
    expect(r.model).toBe('claude-opus-4-6');
    expect(r.inputTokens).toBe(1000);
    expect(r.outputTokens).toBe(500);
    expect(r.costMicros).toBe(25000);
    expect(r.startedAt).toBe('2026-04-25T00:00:00.000Z');
    expect(body.nextAfterId).toBe(123);
  });

  test('returns hasMore=true and correct nextAfterId when limit is reached', async () => {
    // Return limit+1 rows (limit=2, we put 3 rows so handler gets limit+1=3)
    mockRows = [
      makeRow({ id: '1', started_at: new Date('2026-04-25T01:00:00Z') }),
      makeRow({ id: '2', started_at: new Date('2026-04-25T02:00:00Z') }),
      makeRow({ id: '3', started_at: new Date('2026-04-25T03:00:00Z') }),
    ];

    const res = await app.inject({
      method: 'GET',
      url: '/api/usage/ingestion-feed?after_id=0&limit=2',
      headers: { 'x-service-token': MOCK_SERVICE_TOKEN },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{
      rows: unknown[];
      hasMore: boolean;
      nextAfterId: number;
    }>();

    expect(body.hasMore).toBe(true);
    expect(body.rows).toHaveLength(2);
    // nextAfterId is the id of the last returned row (id=2)
    expect(body.nextAfterId).toBe(2);
  });

  test('handles null agentId, invocationId, and actionId gracefully', async () => {
    mockRows = [makeRow({ agent_id: null, invocation_id: null, action_id: null })];

    const res = await app.inject({
      method: 'GET',
      url: '/api/usage/ingestion-feed?after_id=0',
      headers: { 'x-service-token': MOCK_SERVICE_TOKEN },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ rows: Array<{ agentId: null; invocationId: null; actionId: null }> }>();
    expect(body.rows[0].agentId).toBeNull();
    expect(body.rows[0].invocationId).toBeNull();
    expect(body.rows[0].actionId).toBeNull();
  });

  test('meters the vendor-billed terminal states and excludes non-billed failures', async () => {
    mockRows = [makeRow()];

    const res = await app.inject({
      method: 'GET',
      url: '/api/usage/ingestion-feed?after_id=0',
      headers: { 'x-service-token': MOCK_SERVICE_TOKEN },
    });
    expect(res.statusCode).toBe(200);

    const sql = capturedSqls.find((s) => s.includes('developer_proxy_usage_log'));
    expect(sql).toBeDefined();
    // Billed: output the model generated, including cap-hits and aborts.
    expect(sql).toContain('lifecycle_status IN');
    expect(sql).toContain("'completed'");
    expect(sql).toContain("'incomplete'");
    expect(sql).toContain("'aborted_by_client'");
    expect(sql).toContain("'timed_out'");
    // Not billed by the vendor — must never be charged.
    expect(sql).not.toContain("'failed'");
    expect(sql).not.toContain("'transport_error'");
    // The old legacy-status filter is gone.
    expect(sql).not.toContain("status = 'final'");
  });

  test('returns empty rows and nextAfterId=after_id when no rows match', async () => {
    mockRows = [];

    const res = await app.inject({
      method: 'GET',
      url: '/api/usage/ingestion-feed?after_id=0',
      headers: { 'x-service-token': MOCK_SERVICE_TOKEN },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ rows: unknown[]; hasMore: boolean; nextAfterId: number }>();
    expect(body.rows).toHaveLength(0);
    expect(body.hasMore).toBe(false);
    expect(body.nextAfterId).toBe(0);
  });
});
