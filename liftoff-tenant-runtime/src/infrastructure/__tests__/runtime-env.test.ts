import {
  getTenantRuntimeUrl,
  tenantRuntimeUrlState,
  _resetEnvCacheForTests,
  TENANT_RUNTIME_URL_PLACEHOLDER,
} from '../runtime-env';

describe('getTenantRuntimeUrl', () => {
  beforeEach(() => {
    delete process.env.TENANT_RUNTIME_URL;
    _resetEnvCacheForTests();
  });

  it('throws when unset', () => {
    expect(() => getTenantRuntimeUrl()).toThrow(/TENANT_RUNTIME_URL is unset/);
  });

  it('throws when not https://', () => {
    process.env.TENANT_RUNTIME_URL = 'http://insecure.example';
    expect(() => getTenantRuntimeUrl()).toThrow(/expected https:\/\//);
  });

  it('throws when empty string', () => {
    process.env.TENANT_RUNTIME_URL = '';
    expect(() => getTenantRuntimeUrl()).toThrow(/unset/);
  });

  it('returns and caches value when set', () => {
    process.env.TENANT_RUNTIME_URL = 'https://agent-service-abc.run.app';
    expect(getTenantRuntimeUrl()).toBe('https://agent-service-abc.run.app');
    process.env.TENANT_RUNTIME_URL = 'https://different';
    expect(getTenantRuntimeUrl()).toBe('https://agent-service-abc.run.app');
  });
});

describe('tenantRuntimeUrlState', () => {
  beforeEach(() => {
    delete process.env.TENANT_RUNTIME_URL;
    _resetEnvCacheForTests();
  });

  it.each([
    [undefined, 'missing'],
    ['', 'missing'],
    ['http://x', 'malformed'],
    ['https://x', 'set'],
    [TENANT_RUNTIME_URL_PLACEHOLDER, 'placeholder'],
  ] as const)('env=%j → %s', (env, expected) => {
    if (env !== undefined) process.env.TENANT_RUNTIME_URL = env;
    expect(tenantRuntimeUrlState()).toBe(expected);
  });
});

describe('placeholder behavior', () => {
  beforeEach(() => {
    delete process.env.TENANT_RUNTIME_URL;
    _resetEnvCacheForTests();
  });

  it('getTenantRuntimeUrl throws when value is the first-deploy placeholder', () => {
    process.env.TENANT_RUNTIME_URL = TENANT_RUNTIME_URL_PLACEHOLDER;
    expect(() => getTenantRuntimeUrl()).toThrow(/first-deploy sentinel/);
  });
});
