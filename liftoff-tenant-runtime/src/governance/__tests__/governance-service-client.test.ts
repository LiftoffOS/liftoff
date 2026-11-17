// Governance service client tests — tenant-runtime side.
//
// Mirrors src/connectors/connector-service-client.test.ts in structure:
// flag parsing, router-transport round trip, HTTP/2 + session-reuse
// verification.

import {
  createClient,
  createRouterTransport,
  type ConnectRouter,
} from '@connectrpc/connect';
import { create } from '@bufbuild/protobuf';
import { GovernanceService } from '@liftoffos/proto-gen';
import {
  PreflightResponseSchema,
  RecordResponseSchema,
  AuthorizeResponseSchema,
  AuthorizeDecision,
} from '@liftoffos/proto-gen/dist/liftoff/governance/v1/governance_service_pb.js';
import {
  buildTransportOptions,
  resetSharedGovernanceServiceClient,
} from '../governance-service-client';
import {
  getGovernanceServiceMode,
  isGovernanceServiceEnabled,
  isGovernanceShadowMode,
} from '../governance-service-flag';

describe('GOVERNANCE_SERVICE_ENABLED flag', () => {
  const original = process.env.GOVERNANCE_SERVICE_ENABLED;
  afterEach(() => {
    if (original === undefined) delete process.env.GOVERNANCE_SERVICE_ENABLED;
    else process.env.GOVERNANCE_SERVICE_ENABLED = original;
  });

  it('defaults to off when unset', () => {
    delete process.env.GOVERNANCE_SERVICE_ENABLED;
    expect(getGovernanceServiceMode()).toBe('off');
    expect(isGovernanceServiceEnabled()).toBe(false);
    expect(isGovernanceShadowMode()).toBe(false);
  });

  it.each(['shadow', 'SHADOW'])('recognises %s as shadow', (raw) => {
    process.env.GOVERNANCE_SERVICE_ENABLED = raw;
    expect(getGovernanceServiceMode()).toBe('shadow');
    expect(isGovernanceShadowMode()).toBe(true);
  });

  it.each(['on', 'ON'])('recognises %s as on', (raw) => {
    process.env.GOVERNANCE_SERVICE_ENABLED = raw;
    expect(getGovernanceServiceMode()).toBe('on');
    expect(isGovernanceShadowMode()).toBe(false);
  });

  it('treats garbage as off', () => {
    process.env.GOVERNANCE_SERVICE_ENABLED = 'maybe';
    expect(getGovernanceServiceMode()).toBe('off');
  });
});

describe('round-trip via createRouterTransport', () => {
  beforeEach(() => resetSharedGovernanceServiceClient());

  it('calls preflight and parses the typed response', async () => {
    const transport = createRouterTransport(({ service }: { service: ConnectRouter['service'] }) => {
      service(GovernanceService, {
        async preflight() {
          return create(PreflightResponseSchema, {
            preflightToken: 'tok-abc',
            version: 7n,
          });
        },
      });
    });
    const client = createClient(GovernanceService, transport);
    const res = await client.preflight({
      tenantContext: { tenantId: 't' },
      agentId: 'a',
      connectorTypes: ['slack'],
      capabilityTier: 'standard',
      executionEnvironment: 'sandbox',
    });
    expect(res.preflightToken).toBe('tok-abc');
    expect(res.version).toBe(7n);
  });

  it('calls authorize and parses the decision enum', async () => {
    const transport = createRouterTransport(({ service }: { service: ConnectRouter['service'] }) => {
      service(GovernanceService, {
        async authorize() {
          return create(AuthorizeResponseSchema, { decision: AuthorizeDecision.ALLOWED });
        },
      });
    });
    const client = createClient(GovernanceService, transport);
    const res = await client.authorize({
      preflightToken: 'tok-abc',
      idempotencyKey: 'idem-1',
      connector: 'slack',
      entityType: 'message',
      actionType: 'send',
      targetRef: 'C123',
    });
    expect(res.decision).toBe(AuthorizeDecision.ALLOWED);
  });

  it('calls record and parses the accepted flag', async () => {
    const transport = createRouterTransport(({ service }: { service: ConnectRouter['service'] }) => {
      service(GovernanceService, {
        async record() {
          return create(RecordResponseSchema, { accepted: true });
        },
      });
    });
    const client = createClient(GovernanceService, transport);
    const res = await client.record({
      preflightToken: 'tok-abc',
      idempotencyKey: 'idem-1',
      connector: 'slack',
      entityType: 'message',
      actionType: 'send',
      targetRef: 'C123',
      traceId: 't1',
      durationMs: 120n,
      status: 3,
      error: '',
      costUsd: 0.003,
    });
    expect(res.accepted).toBe(true);
  });
});

describe('buildTransportOptions — HTTP/2 keep-alive (parity with connector-service client)', () => {
  it('uses HTTP/2 so Authorize RPCs multiplex over a single session', () => {
    const opts = buildTransportOptions('https://governance-engine.example.com', []);
    expect(opts.httpVersion).toBe('2');
  });

  it('disables idle-connection ping to avoid ERR_HTTP2_INVALID_SESSION crashes', () => {
    // Rationale: connectrpc/connect-es#1143 — ping on idle races with session
    // teardown and throws from the ping timer.
    const opts = buildTransportOptions('https://governance-engine.example.com', []);
    expect(opts.pingIdleConnection).toBe(false);
    expect(typeof opts.pingIntervalMs).toBe('number');
    expect(opts.pingIntervalMs).toBeGreaterThan(0);
    expect(opts.pingIntervalMs).toBeLessThan(60_000);
  });

  it('sets a finite idleConnectionTimeoutMs so dead sessions are reaped', () => {
    const opts = buildTransportOptions('https://governance-engine.example.com', []);
    expect(typeof opts.idleConnectionTimeoutMs).toBe('number');
    expect(opts.idleConnectionTimeoutMs).toBeGreaterThan(0);
  });

  it('threads the caller-provided baseUrl and interceptors through unchanged', () => {
    const sentinelInterceptor = ((next: unknown) => next) as never;
    const opts = buildTransportOptions('https://example.test', [sentinelInterceptor]);
    expect(opts.baseUrl).toBe('https://example.test');
    expect(opts.interceptors).toEqual([sentinelInterceptor]);
  });
});

describe('getGovernanceServiceClient reuses a shared instance', () => {
  beforeEach(() => {
    resetSharedGovernanceServiceClient();
    process.env.GOVERNANCE_SERVICE_URL = 'https://governance-engine.example.com';
  });
  afterEach(() => {
    delete process.env.GOVERNANCE_SERVICE_URL;
    resetSharedGovernanceServiceClient();
  });

  it('returns the same client across calls so the HTTP/2 session is retained', async () => {
    const { getGovernanceServiceClient } = await import('../governance-service-client');
    const a = getGovernanceServiceClient();
    const b = getGovernanceServiceClient();
    expect(a).toBe(b);
  });

  it('throws when GOVERNANCE_SERVICE_URL is not set', async () => {
    delete process.env.GOVERNANCE_SERVICE_URL;
    resetSharedGovernanceServiceClient();
    const { getGovernanceServiceClient } = await import('../governance-service-client');
    expect(() => getGovernanceServiceClient()).toThrow(/GOVERNANCE_SERVICE_URL/);
  });
});
