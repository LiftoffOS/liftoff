// §8.2: every origin in the execute dispatcher stamps the structured error
// contract onto the ExecuteResponse. This suite covers the deterministic
// native-executor origin end-to-end (thrown vendor error → classifyError →
// error_code / retryable / recovery on the wire). The composio origins are
// covered by defaultComposioErrorMap (composio-overlays unit tests) + the
// connector-types classifyError table; the errorResponse fence guarantees no
// origin can bypass the contract.
//
// NOTE: requires @liftoffos/proto-gen@^0.11.0 (ExecuteResponse fields 6–9) and
// @liftoffos/connector-types@^0.10.0 (tool-error taxonomy) to be installed.

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

const NATIVE_TYPE = 'test_native_classify';

beforeEach(() => {
  jest.clearAllMocks();
  mockGetCredentials.mockResolvedValue({ flowKind: 'static_oauth', accessToken: 'ignored' });
  // A non-composio_managed type → skips the composio branch → native executor.
  mockGetConnectorConfig.mockResolvedValue({ connectorType: NATIVE_TYPE, config: {} });
});

afterEach(() => unregisterAllConnectorExecutors());

async function runOnce() {
  return runConnectorExecution({
    tenantId: 't1',
    connectorId: 'c1',
    functionName: 'do_thing',
    input: {},
    idempotencyKey: 'k1',
    traceId: 'tr1',
  });
}

describe('native executor failure → classified error contract', () => {
  it('maps a 404-shaped vendor error to not_found (non-retryable) with recovery text', async () => {
    registerConnectorExecutor(NATIVE_TYPE, async () => {
      throw Object.assign(new Error('resource missing'), { status: 404 });
    });
    const resp = await runOnce();
    expect(resp.success).toBe(false);
    expect(resp.errorCode).toBe('not_found');
    expect(resp.retryable).toBe(false);
    expect(resp.recovery.length).toBeGreaterThan(0);
    expect(resp.error).toContain('resource missing');
  });

  it('maps a 429-shaped vendor error to rate_limited (retryable)', async () => {
    registerConnectorExecutor(NATIVE_TYPE, async () => {
      throw Object.assign(new Error('too many requests'), { statusCode: 429 });
    });
    const resp = await runOnce();
    expect(resp.errorCode).toBe('rate_limited');
    expect(resp.retryable).toBe(true);
  });

  it('falls back to internal_error for an unclassifiable throw', async () => {
    registerConnectorExecutor(NATIVE_TYPE, async () => {
      throw new Error('something entirely unexpected');
    });
    const resp = await runOnce();
    expect(resp.errorCode).toBe('internal_error');
    expect(resp.retryable).toBe(false);
  });
});
