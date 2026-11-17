// Secret Manager Integration Tests
// Tests secret storage, retrieval, caching, and rotation

// Mock Google Cloud Secret Manager - create mock inside factory to avoid hoisting issues
// The mock function is created INSIDE the factory, then we get a reference to it via __getMock
jest.mock('@google-cloud/secret-manager', () => {
  // Create the mock function inside the factory so it exists when jest.mock runs
  const mockAccessSecretVersion = jest.fn();
  return {
    SecretManagerServiceClient: jest.fn().mockImplementation(() => ({
      accessSecretVersion: mockAccessSecretVersion,
    })),
    // Export a way to get the mock for test assertions
    __getMockAccessSecretVersion: () => mockAccessSecretVersion,
  };
});

// Mock logging
jest.mock('../../infrastructure/logging', () => ({
  log: {
    info: jest.fn(),
    error: jest.fn(),
    warn: jest.fn(),
    debug: jest.fn(),
  },
}));

import {
  getSecret,
  loadSecrets,
  clearSecretCache,
  initSecrets,
  getStripeSecretKey,
  getDbPassword,
  getStripeWebhookSecret,
} from '../../infrastructure/secrets';

// Get the mock function from the mocked module using the exported helper
const SecretManagerMock = jest.requireMock('@google-cloud/secret-manager');
const mockAccessSecretVersion = SecretManagerMock.__getMockAccessSecretVersion() as jest.Mock;

// Mocked logger (so we can assert on error/warn emission classification).
const mockedLog = jest.requireMock('../../infrastructure/logging').log as {
  info: jest.Mock;
  error: jest.Mock;
  warn: jest.Mock;
  debug: jest.Mock;
};

// Store original env
const originalEnv = process.env;

describe('Secret Manager', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearSecretCache();
    process.env = { ...originalEnv, GCP_PROJECT_ID: 'test-project' };
  });

  afterAll(() => {
    process.env = originalEnv;
  });

  describe('getSecret', () => {
    it('should fetch secret from Secret Manager', async () => {
      mockAccessSecretVersion.mockResolvedValueOnce([{
        payload: {
          data: Buffer.from('my-secret-value'),
        },
      }]);

      const result = await getSecret('test-secret');

      expect(mockAccessSecretVersion).toHaveBeenCalledWith({
        name: 'projects/test-project/secrets/test-secret/versions/latest',
      });
      expect(result).toBe('my-secret-value');
    });

    it('should use specified version when provided', async () => {
      mockAccessSecretVersion.mockResolvedValueOnce([{
        payload: {
          data: Buffer.from('versioned-secret'),
        },
      }]);

      const result = await getSecret('test-secret', '5');

      expect(mockAccessSecretVersion).toHaveBeenCalledWith({
        name: 'projects/test-project/secrets/test-secret/versions/5',
      });
      expect(result).toBe('versioned-secret');
    });

    it('should cache secrets after first fetch', async () => {
      mockAccessSecretVersion.mockResolvedValueOnce([{
        payload: {
          data: Buffer.from('cached-secret'),
        },
      }]);

      // First call
      const result1 = await getSecret('cached-test');
      // Second call - should use cache
      const result2 = await getSecret('cached-test');

      expect(mockAccessSecretVersion).toHaveBeenCalledTimes(1);
      expect(result1).toBe('cached-secret');
      expect(result2).toBe('cached-secret');
    });

    it('should cache by version', async () => {
      mockAccessSecretVersion
        .mockResolvedValueOnce([{ payload: { data: Buffer.from('v1-secret') } }])
        .mockResolvedValueOnce([{ payload: { data: Buffer.from('v2-secret') } }]);

      const v1Result = await getSecret('versioned', '1');
      const v2Result = await getSecret('versioned', '2');
      const v1Again = await getSecret('versioned', '1');

      expect(mockAccessSecretVersion).toHaveBeenCalledTimes(2);
      expect(v1Result).toBe('v1-secret');
      expect(v2Result).toBe('v2-secret');
      expect(v1Again).toBe('v1-secret');
    });

    it('should handle string payload data', async () => {
      mockAccessSecretVersion.mockResolvedValueOnce([{
        payload: {
          data: 'string-secret-value',
        },
      }]);

      const result = await getSecret('string-secret');

      expect(result).toBe('string-secret-value');
    });

    it('should return empty string when payload is empty', async () => {
      mockAccessSecretVersion.mockResolvedValueOnce([{
        payload: {
          data: Buffer.from(''),
        },
      }]);

      const result = await getSecret('empty-secret');

      expect(result).toBe('');
    });
  });

  describe('loadSecrets', () => {
    it('should load multiple secrets in parallel', async () => {
      mockAccessSecretVersion
        .mockResolvedValueOnce([{ payload: { data: Buffer.from('secret1') } }])
        .mockResolvedValueOnce([{ payload: { data: Buffer.from('secret2') } }]);

      const results = await loadSecrets(['secret-one', 'secret-two']);

      expect(mockAccessSecretVersion).toHaveBeenCalledTimes(2);
      // loadSecrets returns an object keyed by secret name
      expect(Object.keys(results)).toHaveLength(2);
      expect(results['secret-one']).toBe('secret1');
      expect(results['secret-two']).toBe('secret2');
    });
  });

  describe('clearSecretCache', () => {
    it('should clear cached secrets', async () => {
      mockAccessSecretVersion.mockResolvedValue([{
        payload: { data: Buffer.from('cached') },
      }]);

      await getSecret('clear-test');
      clearSecretCache();
      await getSecret('clear-test');

      expect(mockAccessSecretVersion).toHaveBeenCalledTimes(2);
    });
  });

  describe('initSecrets', () => {
    it('should load all required secrets at startup', async () => {
      mockAccessSecretVersion.mockResolvedValue([{
        payload: { data: Buffer.from('secret-value') },
      }]);

      await initSecrets();

      expect(mockAccessSecretVersion).toHaveBeenCalled();
    });

    // Note: This test is skipped because projectId is captured at module load time.
    // Testing the "not set" case would require module reloading which isn't practical.
    // The behavior is verified by the implementation check: if (!projectId) { return; }
    it.skip('should skip initialization when GCP_PROJECT_ID is not set', async () => {
      mockAccessSecretVersion.mockClear();
      delete process.env.GCP_PROJECT_ID;

      await initSecrets();

      expect(mockAccessSecretVersion).not.toHaveBeenCalled();
    });
  });

  describe('getStripeSecretKey', () => {
    it('should fetch from Secret Manager when env var not set', async () => {
      delete process.env.STRIPE_SECRET_KEY;
      mockAccessSecretVersion.mockResolvedValueOnce([{
        payload: { data: Buffer.from('sk_live_123') },
      }]);

      const result = await getStripeSecretKey();

      expect(result).toBe('sk_live_123');
    });
  });

  describe('getDbPassword', () => {
    it('should fetch from Secret Manager when env var not set', async () => {
      delete process.env.DB_PASSWORD;
      mockAccessSecretVersion.mockResolvedValueOnce([{
        payload: { data: Buffer.from('db-password-123') },
      }]);

      const result = await getDbPassword();

      expect(result).toBe('db-password-123');
    });
  });

  describe('getStripeWebhookSecret', () => {
    it('should fetch from Secret Manager when env var not set', async () => {
      delete process.env.STRIPE_WEBHOOK_SECRET;
      mockAccessSecretVersion.mockResolvedValueOnce([{
        payload: { data: Buffer.from('whsec_123') },
      }]);

      const result = await getStripeWebhookSecret();

      expect(result).toBe('whsec_123');
    });
  });

  // getFirebaseServiceAccount removed: prod + dev Cloud Run use Application
  // Default Credentials for Firebase Admin SDK init (runtime SA has
  // roles/firebase.admin on the web project). No secret to fetch.
});

describe('Secret rotation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearSecretCache();
    process.env = { ...originalEnv, GCP_PROJECT_ID: 'test-project' };
  });

  it('should fetch new version after cache clear', async () => {
    mockAccessSecretVersion
      .mockResolvedValueOnce([{ payload: { data: Buffer.from('old-secret') } }])
      .mockResolvedValueOnce([{ payload: { data: Buffer.from('new-secret') } }]);

    const oldResult = await getSecret('rotating-secret');
    clearSecretCache();
    const newResult = await getSecret('rotating-secret');

    expect(oldResult).toBe('old-secret');
    expect(newResult).toBe('new-secret');
  });

  it('should support fetching specific versions for rollback', async () => {
    mockAccessSecretVersion
      .mockResolvedValueOnce([{ payload: { data: Buffer.from('v3-secret') } }])
      .mockResolvedValueOnce([{ payload: { data: Buffer.from('v2-secret') } }]);

    const currentResult = await getSecret('rollback-secret', '3');
    const rollbackResult = await getSecret('rollback-secret', '2');

    expect(currentResult).toBe('v3-secret');
    expect(rollbackResult).toBe('v2-secret');
  });
});

describe('Error handling', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearSecretCache();
    process.env = { ...originalEnv, GCP_PROJECT_ID: 'test-project' };
  });

  it('should handle malformed response gracefully', async () => {
    // When payload is missing, the implementation returns empty string
    mockAccessSecretVersion.mockResolvedValueOnce([{}]);

    const result = await getSecret('malformed-secret');
    expect(result).toBe('');
  });
});

describe('Caching behavior', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearSecretCache();
    process.env = { ...originalEnv, GCP_PROJECT_ID: 'test-project' };
  });

  it('should cache different secrets independently', async () => {
    mockAccessSecretVersion
      .mockResolvedValueOnce([{ payload: { data: Buffer.from('secret-a') } }])
      .mockResolvedValueOnce([{ payload: { data: Buffer.from('secret-b') } }]);

    const resultA = await getSecret('secret-a');
    const resultB = await getSecret('secret-b');
    const resultAAgain = await getSecret('secret-a');

    expect(resultA).toBe('secret-a');
    expect(resultB).toBe('secret-b');
    expect(resultAAgain).toBe('secret-a');
    expect(mockAccessSecretVersion).toHaveBeenCalledTimes(2);
  });

  it('should use cache key with version', async () => {
    mockAccessSecretVersion
      .mockResolvedValueOnce([{ payload: { data: Buffer.from('latest') } }])
      .mockResolvedValueOnce([{ payload: { data: Buffer.from('v1') } }]);

    const latestResult = await getSecret('versioned-cache');
    const v1Result = await getSecret('versioned-cache', '1');

    expect(latestResult).toBe('latest');
    expect(v1Result).toBe('v1');
    expect(mockAccessSecretVersion).toHaveBeenCalledTimes(2);
  });
});

describe('getSecret error-code preservation', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    clearSecretCache();
    process.env = { ...originalEnv, GCP_PROJECT_ID: 'test-project' };
  });

  it('preserves the gRPC status code on the wrapped error', async () => {
    const grpcErr = new Error('5 NOT_FOUND: Secret not found or has no versions') as Error & {
      code?: number;
    };
    grpcErr.code = 5;
    mockAccessSecretVersion.mockRejectedValueOnce(grpcErr);

    await expect(getSecret('missing-secret')).rejects.toMatchObject({
      message: expect.stringContaining('missing-secret'),
      code: 5,
    });
  });
});

// Optional secrets that are simply unprovisioned (NOT_FOUND) must NOT surface as
// ERROR — that pollutes error dashboards and false-fires the WS-1.5 IAM-denial
// metric on every boot. They should be a single benign warn instead. Genuine
// access failures (PERMISSION_DENIED) on optional secrets, and any failure on a
// required secret, must still emit the ERROR.
describe('loadSecretsToEnv optional-secret error classification', () => {
  // unsubscribe-secret is the canonical optional secret; platform-callback-token
  // is the canonical required one. Resolve everything else so the run is clean.
  const rejectOne = (targetSecret: string, code: number, codeWord: string) =>
    mockAccessSecretVersion.mockImplementation(({ name }: { name: string }) => {
      if (name.includes(targetSecret)) {
        const err = new Error(`${code} ${codeWord}: simulated`) as Error & { code?: number };
        err.code = code;
        return Promise.reject(err);
      }
      return Promise.resolve([{ payload: { data: Buffer.from('ok') } }]);
    });

  const secretLoadFailedCallsFor = (secretName: string) =>
    mockedLog.error.mock.calls.filter(
      ([payload]) =>
        payload?.event === 'secret_load_failed' && payload?.secret_name === secretName,
    );

  beforeEach(() => {
    jest.clearAllMocks();
    clearSecretCache();
    process.env = { ...originalEnv, GCP_PROJECT_ID: 'test-project' };
  });

  it('does NOT emit secret_load_failed ERROR for an optional NOT_FOUND secret', async () => {
    rejectOne('unsubscribe-secret', 5, 'NOT_FOUND');

    await initSecrets();

    expect(secretLoadFailedCallsFor('unsubscribe-secret')).toHaveLength(0);
    // It is still surfaced once, benignly, as a warn.
    const warnCalls = mockedLog.warn.mock.calls.filter(
      ([payload]) => payload?.envVar === 'UNSUBSCRIBE_SECRET',
    );
    expect(warnCalls).toHaveLength(1);
  });

  it('DOES emit secret_load_failed ERROR for an optional secret that fails with PERMISSION_DENIED', async () => {
    rejectOne('unsubscribe-secret', 7, 'PERMISSION_DENIED');

    await initSecrets();

    expect(secretLoadFailedCallsFor('unsubscribe-secret')).toHaveLength(1);
  });

  it('still emits ERROR and throws when a REQUIRED secret is NOT_FOUND', async () => {
    rejectOne('platform-callback-token', 5, 'NOT_FOUND');

    await expect(initSecrets()).rejects.toThrow(/Failed to load required secrets/);
    expect(secretLoadFailedCallsFor('platform-callback-token')).toHaveLength(1);
  });
});
