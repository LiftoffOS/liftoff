// Governance-engine Preflight RPC-hop latency benchmark.
//
// Plan target is Authorize < 3ms p95 (covered by authorize-hop.bench.test.ts).
// Preflight is cache-primer path — called once per invocation — so we
// allow a looser budget (p95 < 10ms, p99 < 25ms). This bench exists to
// catch regressions in the HMAC signer, admission fanout, or the
// PreflightResponse marshaller.
//
// Same stubbing strategy as authorize-hop: admission + HITL return
// pre-resolved promises, so the measurement captures Connect-RPC hop +
// admission service composition + token signing only.

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { createClient } from '@connectrpc/connect';
import { createConnectTransport } from '@connectrpc/connect-node';
import { GovernanceService } from '@liftoffos/proto-gen';
import type { Logger } from '@liftoffos/telemetry';
import { buildApp } from '../server.js';
import {
  assertLatency,
  formatStats,
  measureLatencies,
} from '../test-utils/benchmark.js';

// See authorize-hop.bench.test.ts for the CI jitter rationale.
const CI_JITTER_FACTOR = process.env.CI ? 10 : 1;
const PREFLIGHT_BUDGET = {
  p95: { max: 10 * CI_JITTER_FACTOR },
  p99: { max: 25 * CI_JITTER_FACTOR },
};
const ITERATIONS = 1000;
const WARMUP = 50;

const silentLog = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child() {
    return silentLog;
  },
} as unknown as Logger;

jest.mock('../admission/service.js', () => ({
  AdmissionService: jest.fn().mockImplementation(() => ({
    checkAdmission: jest.fn().mockResolvedValue({ allowed: true }),
    getKillSwitchState: jest.fn().mockResolvedValue({
      global: false,
      tenant: false,
      agentIds: [],
      connectorTypes: [],
    }),
  })),
}));

jest.mock('../hitl-enforcement/service.js', () => ({
  hitlEnforcementService: {
    resolveHitlLevel: jest.fn().mockResolvedValue(4),
    getOversightSettings: jest.fn().mockResolvedValue(null),
    createApprovalRequest: jest.fn().mockResolvedValue({ id: 'x', status: 'pending' }),
    listPendingApprovals: jest
      .fn()
      .mockResolvedValue({ approvals: [], nextCursor: null }),
  },
}));

jest.mock('../action-ledger/service.js', () => ({
  ActionLedgerService: jest.fn().mockImplementation(() => ({
    getByIdempotencyKey: jest.fn().mockResolvedValue(null),
    recordIntent: jest.fn().mockResolvedValue('a'),
    recordOutcome: jest.fn().mockResolvedValue(undefined),
    recordFailure: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../usage-ledger/service.js', () => ({
  UsageLedgerService: jest.fn().mockImplementation(() => ({
    recordUsage: jest.fn().mockResolvedValue(undefined),
  })),
}));

jest.mock('../audit/service.js', () => ({
  insertAuditLog: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('@liftoffos/telemetry', () => {
  const actual = jest.requireActual('@liftoffos/telemetry');
  return {
    ...actual,
    withSpan: (
      _service: string,
      _name: string,
      _attrs: unknown,
      fn: () => unknown,
    ) => fn(),
  };
});

jest.mock('../infrastructure/logging.js', () => ({
  logger: {
    debug: () => undefined,
    info: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    child: () => ({
      debug: () => undefined,
      info: () => undefined,
      warn: () => undefined,
      error: () => undefined,
    }),
  },
}));

function startServer(): Promise<{ server: http.Server; baseUrl: string }> {
  const app = buildApp({ port: 0, log: silentLog });
  return new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => {
      const addr = server.address() as AddressInfo;
      resolve({ server, baseUrl: `http://127.0.0.1:${addr.port}` });
    });
    server.on('error', reject);
  });
}

function makeClient(baseUrl: string) {
  const transport = createConnectTransport({
    baseUrl,
    httpVersion: '1.1',
    interceptors: [
      (next) => async (req) => {
        req.header.set('X-Service-Auth', 'bench-token');
        return next(req);
      },
    ],
  });
  return createClient(GovernanceService, transport);
}

describe('governance-engine Preflight RPC-hop latency', () => {
  let server: http.Server;
  let client: ReturnType<typeof makeClient>;
  const origToken = process.env.GOVERNANCE_SERVICE_TOKEN;
  const origSignKey = process.env.GOVERNANCE_PREFLIGHT_SIGNING_KEY;

  beforeAll(async () => {
    process.env.GOVERNANCE_SERVICE_TOKEN = 'bench-token';
    process.env.GOVERNANCE_PREFLIGHT_SIGNING_KEY = 'bench-signing-key';
    const started = await startServer();
    server = started.server;
    client = makeClient(started.baseUrl);
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    if (origToken === undefined) delete process.env.GOVERNANCE_SERVICE_TOKEN;
    else process.env.GOVERNANCE_SERVICE_TOKEN = origToken;
    if (origSignKey === undefined) delete process.env.GOVERNANCE_PREFLIGHT_SIGNING_KEY;
    else process.env.GOVERNANCE_PREFLIGHT_SIGNING_KEY = origSignKey;
  });

  it(`Preflight p95 < ${PREFLIGHT_BUDGET.p95.max}ms, p99 < ${PREFLIGHT_BUDGET.p99.max}ms`, async () => {
    const stats = await measureLatencies({
      iterations: ITERATIONS,
      warmup: WARMUP,
      fn: () =>
        client.preflight({
          // TenantContext is a proto message; we rely on the Connect
          // client's PartialMessage coercion so we only need the fields
          // the handler reads. `tenantId` is the only one required for
          // Preflight's admission/HITL fanout.
          tenantContext: { tenantId: 'bench-tenant' } as Parameters<
            typeof client.preflight
          >[0]['tenantContext'],
          agentId: 'bench-agent',
          capabilityTier: '',
          executionEnvironment: '',
        }),
    });

    // eslint-disable-next-line no-console
    console.log(formatStats('Preflight RPC', stats));
    assertLatency(stats, PREFLIGHT_BUDGET, 'Preflight RPC');
  });
});
