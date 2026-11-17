// Credential-echo guard WIRING test (G1/G2). Proves that runConnectorExecution
// — the single seam both Execute and ExecuteBatch route through (router.ts) —
// actually threads the resolved credential values into the guard at each return
// site, so a connector that echoes the injected credential in its result or
// error has it redacted before the ExecuteResponse leaves the process.
//
// Uses the same mock harness as execute-dispatcher-error-classification.test.ts
// (mock credentialService + logging + composio-client) so it runs without the
// real telemetry stack. The full-router end-to-end path is additionally covered
// by execute-integration.test.ts in CI.

const mockGetCredentials = jest.fn();
const mockGetConnectorConfig = jest.fn();

jest.mock('../../credentials/service.js', () => ({
  credentialService: {
    getCredentials: (...a: unknown[]) => mockGetCredentials(...a),
    getConnectorConfig: (...a: unknown[]) => mockGetConnectorConfig(...a),
  },
  OAuthRefreshError: class OAuthRefreshError extends Error {},
}));

jest.mock('../../oauth/composio-client.js', () => ({
  getComposio: () => ({ tools: { execute: jest.fn() } }),
}));

jest.mock('../../infra/logging.js', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  runConnectorExecution,
  registerConnectorExecutor,
  unregisterAllConnectorExecutors,
} from '../execute-dispatcher.js';

const NATIVE_TYPE = 'test_native_redaction';
const SECRET = 'echoed-api-key-abcdef1234567890';

beforeEach(() => {
  jest.clearAllMocks();
  // The injected credential the guard must scrub if a connector echoes it.
  mockGetCredentials.mockResolvedValue({ flowKind: 'api_key', apiKey: SECRET });
  mockGetConnectorConfig.mockResolvedValue({ connectorType: NATIVE_TYPE, config: {} });
});

afterEach(() => unregisterAllConnectorExecutors());

function runOnce(functionName = 'do_thing') {
  return runConnectorExecution({
    tenantId: 't1',
    connectorId: 'c1',
    functionName,
    input: {},
    idempotencyKey: 'k1',
    traceId: 'tr1',
  });
}

describe('runConnectorExecution — credential echo guard wiring', () => {
  it('redacts an injected credential echoed in a successful result (nested + in a string)', async () => {
    registerConnectorExecutor(NATIVE_TYPE, async (c) => ({
      result: {
        echoed: `Authorization used token=${c.credentials.apiKey ?? ''}`,
        nested: { deep: [c.credentials.apiKey ?? ''] },
      },
    }));
    const resp = await runOnce();
    expect(resp.success).toBe(true);
    const serialized = JSON.stringify(resp.result);
    expect(serialized).not.toContain(SECRET);
    expect(serialized).toContain('[REDACTED]');
  });

  it('redacts an injected credential echoed in a thrown error message', async () => {
    registerConnectorExecutor(NATIVE_TYPE, async () => {
      throw new Error(`vendor rejected request with api_token=${SECRET}`);
    });
    const resp = await runOnce();
    expect(resp.success).toBe(false);
    expect(resp.error).not.toContain(SECRET);
    expect(resp.error).toContain('[REDACTED]');
  });

  it('leaves a clean result untouched (guard is transparent when nothing echoes)', async () => {
    registerConnectorExecutor(NATIVE_TYPE, async () => ({
      result: { id: 42, name: 'acme', ok: true },
    }));
    const resp = await runOnce();
    expect(resp.success).toBe(true);
    expect(resp.result).toMatchObject({ id: 42, name: 'acme', ok: true });
  });

  it('redacts on every call — the per-item coverage ExecuteBatch inherits (router loops runConnectorExecution per op)', async () => {
    registerConnectorExecutor(NATIVE_TYPE, async (c) => ({
      result: { leaked: c.credentials.apiKey ?? '', fn: c.functionName },
    }));
    // Mirror the ExecuteBatch handler's per-operation loop (router.ts) with two ops.
    const results = await Promise.all([runOnce('a'), runOnce('b')]);
    expect(results).toHaveLength(2);
    for (const resp of results) {
      const serialized = JSON.stringify(resp.result);
      expect(serialized).not.toContain(SECRET);
      expect(serialized).toContain('[REDACTED]');
    }
  });
});
