// Jest Setup File — runs before each test file.
//
// Ported (and slimmed) from tenant-runtime/src/test-utils/setup.ts.
// governance-engine has a smaller infrastructure surface — just database,
// logging, and stripe-meter — so we only mock those here.
//
// Tests that declare their own `jest.mock` for these paths (e.g.
// stripe-meter.test.ts) still win because per-file mocks take precedence
// over setup-file mocks for the same resolved module path.

// Environment defaults needed by any code that reads env at import time
// (e.g. Stripe SDK construction in src/infrastructure/stripe-meter.ts).
process.env.NODE_ENV = 'test';
process.env.DB_HOST = 'localhost';
process.env.DB_NAME = 'test_db';
process.env.DB_USER = 'test_user';
process.env.DB_PASSWORD = 'test_password';
process.env.GCP_PROJECT_ID = 'test-project';
process.env.ENVIRONMENT = 'test';
process.env.STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY ?? 'sk_test_dummy';
process.env.GOVERNANCE_SERVICE_TOKEN =
  process.env.GOVERNANCE_SERVICE_TOKEN ?? 'test-token';

// Mock google-auth-library to prevent ADC credential loading in CI.
jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getClient: jest.fn().mockResolvedValue({
      request: jest.fn().mockResolvedValue({ data: {} }),
      getAccessToken: jest.fn().mockResolvedValue({ token: 'mock-token' }),
    }),
    getProjectId: jest.fn().mockResolvedValue('test-project'),
    getApplicationDefault: jest.fn().mockResolvedValue({ credential: {} }),
  })),
}));

// Global database-pool mock — the Proxy `pool` export from the real module
// can't be auto-mocked (jest's automock can't introspect a Proxy), so we
// install a concrete mock object here and the `jest.mock('../infrastructure/database')`
// calls in test files end up using this factory.
jest.mock('../infrastructure/database', () => {
  const mockClient = {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    release: jest.fn(),
  };
  const mockPool = {
    query: jest.fn().mockResolvedValue({ rows: [], rowCount: 0 }),
    connect: jest.fn().mockResolvedValue(mockClient),
    end: jest.fn(),
    on: jest.fn(),
  };
  return {
    pool: mockPool,
    getPool: jest.fn().mockReturnValue(mockPool),
    getPoolForService: jest.fn().mockReturnValue(mockPool),
    withTenantScope: jest.fn(
      async (
        _tenantId: string,
        fn: (client: unknown) => Promise<unknown>,
      ) => fn(mockClient),
    ),
    closePools: jest.fn().mockResolvedValue(undefined),
    getPoolStats: jest.fn().mockReturnValue({}),
  };
});

// Silence logger output during tests. Both `logger` and `log` are exported
// from the real module so call sites can import either name.
jest.mock('../infrastructure/logging', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const stub: any = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  stub.child = jest.fn(() => stub);
  return {
    logger: stub,
    log: stub,
    logAudit: jest.fn(),
    withTraceContext: jest.fn((_ctx: unknown, fn: () => unknown) => fn()),
    getRequestTraceContext: jest.fn(() => ({})),
  };
});

// Keep the Stripe SDK inert so modules that construct `new Stripe(...)` at
// import time (e.g. src/infrastructure/stripe-meter.ts, transitively pulled
// in by server.ts via usage-ledger) don't blow up on missing credentials.
jest.mock('stripe', () => {
  const StripeMock = jest.fn().mockImplementation(() => ({
    billing: {
      meterEvents: { create: jest.fn().mockResolvedValue({}) },
      meters: {
        list: jest.fn().mockResolvedValue({ data: [] }),
        listEventSummaries: jest.fn().mockResolvedValue({ data: [] }),
      },
    },
  }));
  return { __esModule: true, default: StripeMock };
});

// Reset all mocks before each test so call-count / mockResolvedValueOnce
// queues start clean.
beforeEach(() => {
  jest.clearAllMocks();
});

jest.setTimeout(10000);
