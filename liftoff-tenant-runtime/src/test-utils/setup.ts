// Jest Setup File
// Runs before each test file

import http from 'http';
import https from 'https';
import net from 'net';
import { setGlobalDispatcher, Agent as UndiciAgent } from 'undici';

// ── Test servers never bind inside the ephemeral port range ──────────────
//
// This is the fix for a flake that failed ~1 full-suite run in 6 under load,
// in a different HTTP suite every time, with three faces: `socket hang up`,
// a 404 from a route that exists, and a 10s timeout. All three are one bug.
//
// Route tests bind a fresh server per request — `supertest(app)` calls
// `app.listen(0)` — and there are ~120 such call sites, so a full run binds
// hundreds of servers. `listen(0)` takes a port from the OS ephemeral range
// (49152-65535 here), which is the SAME pool client sockets draw from, and
// closed connections sit in TIME_WAIT for 2*MSL (30s here; ~558 were lingering
// when this was diagnosed). Node sets SO_REUSEADDR, so binding a port that
// still has a TIME_WAIT entry SUCCEEDS rather than failing — and then a stale
// segment from the previous connection reaches the new listener. Depending on
// timing that is an RST (socket hang up), a request answered by a server that
// has never heard of the route (404), or a segment that simply never arrives
// (timeout).
//
// So: keep test servers out of the ephemeral range entirely. Each jest worker
// gets its own 1000-port band well below 49152, and ports are handed out
// monotonically within it, so a port is not reused until ~1000 binds later —
// far longer than any TIME_WAIT window. A client socket can never collide with
// a listener because the two now live in disjoint ranges.
//
// Only the "any free port" forms are rewritten. An explicit port, a unix
// socket path, or a handle passes through untouched, and if the chosen port is
// somehow taken the original port-0 behaviour is restored for that call.
const WORKER_ID = Number.parseInt(process.env.JEST_WORKER_ID ?? '1', 10) || 1;
const PORT_BAND_SIZE = 1000;
const PORT_BAND_START = 20000 + (WORKER_ID - 1) * PORT_BAND_SIZE;
let portCursor = 0;

function nextTestPort(): number {
  const port = PORT_BAND_START + (portCursor % PORT_BAND_SIZE);
  portCursor += 1;
  return port;
}

// `net.Server.listen` is heavily overloaded, so the wrapper takes the argument
// list untyped and re-dispatches to the original. The narrowing below is what
// makes that safe: anything that is not an "any free port" call is forwarded
// byte-for-byte.
type ListenFn = (...args: unknown[]) => net.Server;
const originalListen = net.Server.prototype.listen as unknown as ListenFn;

function wantsAnyPort(args: unknown[]): boolean {
  if (args.length === 0) return true;
  const first = args[0];
  if (first === 0 || first === undefined || first === null) return true;
  if (typeof first === 'object') {
    const opts = first as Record<string, unknown>;
    if ('path' in opts || 'fd' in opts || 'handle' in opts) return false;
    return opts.port === 0 || opts.port === undefined;
  }
  return false;
}

(net.Server.prototype as unknown as { listen: ListenFn }).listen = function patchedListen(
  this: net.Server,
  ...args: unknown[]
): net.Server {
  if (!wantsAnyPort(args)) return originalListen.apply(this, args);

  const first = args[0];
  const isOptionsForm = typeof first === 'object' && first !== null;
  const rest = args.slice(1).filter((a) => a !== undefined);

  // One-shot fallback: if our band port is taken, retry once with real port-0
  // semantics so this optimisation can never block a test from listening.
  const onError = (err: NodeJS.ErrnoException): void => {
    if (err?.code !== 'EADDRINUSE') return;
    this.removeListener('error', onError);
    originalListen.apply(this, isOptionsForm
      ? [{ ...(first as Record<string, unknown>), port: 0 }, ...rest]
      : [0, ...rest]);
  };
  this.once('error', onError);
  this.once('listening', () => this.removeListener('error', onError));

  const assigned = nextTestPort();
  return originalListen.apply(this, isOptionsForm
    ? [{ ...(first as Record<string, unknown>), port: assigned }, ...rest]
    : [assigned, ...rest]);
};

// ── No HTTP connection reuse in tests ────────────────────────────────────
//
// This is a correctness fix, not a tuning knob. It removes the cause of a
// long-standing ~6%-per-full-run flake that presented as either a 404 or a
// 10-second timeout, in a different express/supertest suite every time.
//
// Route tests bind an ephemeral port (`app.listen(0)`), make one request, and
// close the server. Node 19+ ships `http.globalAgent` with `keepAlive: true`,
// `maxFreeSockets: 256` and `scheduling: 'lifo'`, and the pool is keyed by
// `host:port`. So a closed server's socket is retained, and when the OS later
// recycles that ephemeral port to a DIFFERENT test's server in the same worker,
// the pool hands the new request that stale socket — most-recently-freed first,
// because LIFO. The request then either lands on an app that has never heard of
// the route (404) or on a dead socket (hang → test timeout). It only shows up
// in a full-suite run because that is when enough servers churn for a port to
// be reused inside one worker's lifetime.
//
// Both HTTP stacks in use need it: superagent/supertest go through
// `http.globalAgent`, and the hand-rolled `fetch` helpers go through undici's
// global dispatcher. A fresh connection per request costs nothing against
// 127.0.0.1 and makes every route test independent of what ran before it.
http.globalAgent = new http.Agent({ keepAlive: false });
https.globalAgent = new https.Agent({ keepAlive: false });
setGlobalDispatcher(new UndiciAgent({ pipelining: 0, keepAliveTimeout: 1, keepAliveMaxTimeout: 1 }));

// Set test environment variables
process.env.NODE_ENV = 'test';
process.env.DB_HOST = 'localhost';
process.env.DB_NAME = 'test_db';
process.env.DB_USER = 'test_user';
process.env.DB_PASSWORD = 'test_password';
process.env.GCP_PROJECT_ID = 'test-project';
process.env.ENVIRONMENT = 'test';
// Required-env accessors in src/infrastructure/runtime-env.ts throw if these
// are unset. Previously some tests relied on the env var being set by an
// earlier test file's import side-effects, which created order-dependent
// passes/failures. Set them here so every test boots in a deterministic state.
// Direct process.env access is the only way to set values from outside the
// production code path; the no-restricted-syntax rule that enforces use of
// getTenantRuntimeUrl() in src code does not apply to the test bootstrap.
/* eslint-disable no-restricted-syntax */
process.env.TENANT_RUNTIME_URL = process.env.TENANT_RUNTIME_URL || 'https://agent-service.test.invalid';
process.env.PLATFORM_BACKEND_URL = process.env.PLATFORM_BACKEND_URL || 'https://platform-backend.test.invalid';
process.env.CLOUD_SCHEDULER_SERVICE_ACCOUNT = process.env.CLOUD_SCHEDULER_SERVICE_ACCOUNT || 'scheduler@test.invalid';
// BYOK web-tool resolver builds a connect-rpc client at construction time and
// throws if CONNECTOR_SERVICE_URL is unset. Provide an unreachable default so
// every web-tool test boots; individual tests mock the client where they need
// to assert on lookup behavior.
process.env.CONNECTOR_SERVICE_URL = process.env.CONNECTOR_SERVICE_URL || 'https://connector-service.test.invalid';
/* eslint-enable no-restricted-syntax */

// Mock Google Auth to prevent ADC credential loading in CI
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

// Mock GCP infrastructure services
jest.mock('../infrastructure/tracing', () => ({
  tracer: { startSpan: jest.fn(() => ({ end: jest.fn(), setStatus: jest.fn(), setAttribute: jest.fn() })) },
  startSpan: jest.fn((_name: string, fn: () => unknown) => fn()),
}));

jest.mock('../infrastructure/pubsub', () => ({
  publishMessage: jest.fn().mockResolvedValue(undefined),
  publishToDLQ: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../infrastructure/cloud-tasks', () => ({
  createTask: jest.fn().mockResolvedValue(undefined),
  scheduleTask: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('../infrastructure/secrets', () => ({
  getSecret: jest.fn().mockResolvedValue('test-secret'),
  accessSecretVersion: jest.fn().mockResolvedValue('test-secret'),
  // Provider key getters resolve to null by default: a suite that wants a key
  // present says so, and one that does not gets the "no key configured" branch,
  // which is the branch worth exercising by default — it is where a run either
  // fails loudly or falls through to another vendor's account.
  getXaiApiKey: jest.fn().mockResolvedValue(null),
  getOpenRouterApiKey: jest.fn().mockResolvedValue(null),
}));

jest.mock('../infrastructure/custom-metrics', () => ({
  recordMetric: jest.fn(),
  incrementCounter: jest.fn(),
}));

// Mock the database pool globally
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
  };
});

// Mock the logger to suppress output during tests.
// Both `logger` and `log` are exported from the real module (log = logger)
// so call sites that import either name resolve correctly under jest.
jest.mock('../infrastructure/logging', () => {
  const stub = {
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
    debug: jest.fn(),
  };
  return {
    logger: stub,
    log: stub,
    logAudit: jest.fn(),
    withTraceContext: jest.fn((_ctx: unknown, fn: () => unknown) => fn()),
    getRequestTraceContext: jest.fn(() => ({})),
  };
});

// Default stub for the connector-service Connect-RPC client.
//
// The real `getConnectorServiceClient()` builds a transport pointing at
// CONNECTOR_SERVICE_URL (`connector-service.test.invalid` in test) and tries
// DNS resolution on first call, so anything that transitively imports it
// (web-fetch router → web-tool-secrets → connector-service-client) explodes
// with `ENOTFOUND` once a test exercises the call path. Tests that want to
// assert on the client's behavior already declare their own
// `jest.mock('.../connector-service-client', ...)`, which hoists above this
// one and wins. This default is just a safe no-op for everyone else.
jest.mock('../connectors/connector-service-client', () => {
  const actual = jest.requireActual('../connectors/connector-service-client');
  // Cache the stub so getConnectorServiceClient() returns the SAME object
  // across calls — the real impl memoizes for HTTP/2 session reuse and its
  // own unit test asserts `a === b`.
  const stub = {
    listTenantConnectors: jest.fn().mockResolvedValue({ connectors: [] }),
    execute: jest.fn().mockResolvedValue({ success: false, error: 'stubbed' }),
    executeBatch: jest.fn().mockResolvedValue({ responses: [] }),
    warm: jest.fn().mockResolvedValue({ failures: [] }),
    getCredentials: jest.fn().mockResolvedValue({}),
    getFunctionalTypes: jest.fn().mockResolvedValue({ types: [] }),
    getCapabilities: jest.fn().mockResolvedValue({ capabilities: [] }),
  };
  return {
    ...actual,
    getConnectorServiceClient: () => stub,
  };
});

// Reset all mocks before each test
beforeEach(() => {
  jest.clearAllMocks();
});

// Global test timeout
jest.setTimeout(10000);
