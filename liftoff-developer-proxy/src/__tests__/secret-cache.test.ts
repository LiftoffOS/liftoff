// Secret cache ref-swap validation tests (Phase 1.5 security gate).
// Verifies that validateSecretName rejects mismatched tenant/user/vendor paths.
//
// ESM pattern: jest.unstable_mockModule() + dynamic import, because jest.mock()
// hoisting does not reliably intercept statically-linked ESM modules in
// --experimental-vm-modules mode.

import { jest } from '@jest/globals';

let smCallCount = 0;

jest.unstable_mockModule('@google-cloud/secret-manager', () => ({
  SecretManagerServiceClient: class {
    accessSecretVersion(_: unknown) {
      smCallCount++;
      return Promise.resolve([
        { payload: { data: Buffer.from(JSON.stringify({ anthropicApiKey: 'sk-ant-test' })) } },
      ]);
    }
  },
}));

jest.unstable_mockModule('../infrastructure/config.js', () => ({
  loadConfig: () => ({
    GCP_PROJECT_ID: 'test-project',
    ENVIRONMENT: 'dev' as const,
    DB_INSTANCE_CONNECTION_NAME: 'test:us-west1:db',
    PORT: 8080,
    ANTHROPIC_BASE_URL: 'https://api.anthropic.com',
    PROXY_BASE_URL: 'https://api.example.com/proxy',
    OUTBOX_POLL_INTERVAL_MS: 500,
    OUTBOX_BATCH_SIZE: 100,
  }),
}));

// Dynamic imports must come AFTER unstable_mockModule calls.
type ResolveVendorApiKey = (s: string, t: string, u: string, v: string) => Promise<string>;
type InvalidateSecretCache = (s: string) => void;

let resolveVendorApiKey: ResolveVendorApiKey;
let invalidateSecretCache: InvalidateSecretCache;

beforeAll(async () => {
  const mod = await import('../proxy/secret-cache.js') as {
    resolveVendorApiKey: ResolveVendorApiKey;
    invalidateSecretCache: InvalidateSecretCache;
  };
  resolveVendorApiKey = mod.resolveVendorApiKey;
  invalidateSecretCache = mod.invalidateSecretCache;
});

const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';
const USER   = 'bbbbbbbb-0000-0000-0000-000000000002';
const CRED   = 'cccccccc-0000-0000-0000-000000000003';
const GOOD   = `devproxy---${TENANT}---${USER}---anthropic---${CRED}`;

afterEach(() => {
  invalidateSecretCache(GOOD);
  smCallCount = 0;
});

test('accepts correctly formatted secret name', async () => {
  await expect(resolveVendorApiKey(GOOD, TENANT, USER, 'anthropic')).resolves.toBe('sk-ant-test');
});

test('rejects secret name with wrong tenant', async () => {
  const wrongTenant = `devproxy---ffffffff-0000-0000-0000-000000000000---${USER}---anthropic---${CRED}`;
  await expect(resolveVendorApiKey(wrongTenant, TENANT, USER, 'anthropic')).rejects.toMatchObject({
    code: 'SECRET_REF_MISMATCH',
  });
});

test('rejects secret name with wrong user', async () => {
  const wrongUser = `devproxy---${TENANT}---ffffffff-0000-0000-0000-000000000000---anthropic---${CRED}`;
  await expect(resolveVendorApiKey(wrongUser, TENANT, USER, 'anthropic')).rejects.toMatchObject({
    code: 'SECRET_REF_MISMATCH',
  });
});

test('rejects old-style byok-{uuid} names', async () => {
  const oldStyle = `byok-${CRED}`;
  await expect(resolveVendorApiKey(oldStyle, TENANT, USER, 'anthropic')).rejects.toMatchObject({
    code: 'SECRET_REF_MISMATCH',
  });
});

test('rejects old-style byok--- prefix names', async () => {
  const oldPrefixStyle = `byok---${TENANT}---${USER}---anthropic---${CRED}`;
  await expect(resolveVendorApiKey(oldPrefixStyle, TENANT, USER, 'anthropic')).rejects.toMatchObject({
    code: 'SECRET_REF_MISMATCH',
  });
});

test('rejects empty secret name', async () => {
  await expect(resolveVendorApiKey('', TENANT, USER, 'anthropic')).rejects.toMatchObject({
    code: 'SECRET_REF_MISMATCH',
  });
});

test('caches resolved key — second call skips Secret Manager', async () => {
  await resolveVendorApiKey(GOOD, TENANT, USER, 'anthropic');
  expect(smCallCount).toBe(1);

  await resolveVendorApiKey(GOOD, TENANT, USER, 'anthropic');
  expect(smCallCount).toBe(1); // still 1 — cache hit, not a second SM call
});
