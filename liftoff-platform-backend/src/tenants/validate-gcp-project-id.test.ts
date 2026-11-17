// Unit tests for assertGcpProjectIdMatchesEnv + deriveTenantProjectEnv.
//
// Defends the structural invariant that tenants.gcp_project_id only
// ever carries values produced for the writer's runtime environment.
// See src/tenants/validate-gcp-project-id.ts for context.

import {
  assertGcpProjectIdMatchesEnv,
  deriveTenantProjectEnv,
  CrossEnvironmentGcpProjectError,
} from './validate-gcp-project-id';

describe('deriveTenantProjectEnv', () => {
  // Manual / legacy shape: tenant-<slug>-<env>
  it.each([
    ['tenant-acme-prod', 'prod'],
    ['tenant-acme-dev', 'dev'],
    ['tenant-customer-x-staging', 'staging'],
  ] as const)('manual %s → %s', (input, expected) => {
    expect(deriveTenantProjectEnv(input)).toBe(expected);
  });

  // Provisioning service shape: tenant-<id>-runtime in prod,
  // tenant-<id>-runtime-<env> in non-prod.
  it.each([
    ['tenant-abcdef123-runtime', 'prod'],
    ['tenant-abcdef123-runtime-dev', 'dev'],
    ['tenant-abcdef123-runtime-staging', 'staging'],
  ] as const)('provisioned %s → %s', (input, expected) => {
    expect(deriveTenantProjectEnv(input)).toBe(expected);
  });

  it.each([
    'platform-control-prod', // not a tenant project
    'random-string',
    'tenant-no-suffix',
    '',
    'tenant-',
  ])('unrecognized shape %s → null', (input) => {
    expect(deriveTenantProjectEnv(input)).toBeNull();
  });
});

describe('assertGcpProjectIdMatchesEnv', () => {
  const originalEnv = process.env.ENVIRONMENT;

  afterEach(() => {
    if (originalEnv === undefined) delete process.env.ENVIRONMENT;
    else process.env.ENVIRONMENT = originalEnv;
  });

  it('accepts prod-suffixed manual project when ENVIRONMENT=prod', () => {
    process.env.ENVIRONMENT = 'prod';
    expect(() => assertGcpProjectIdMatchesEnv('tenant-acme-prod')).not.toThrow();
  });

  it('accepts no-suffix provisioned project when ENVIRONMENT=prod', () => {
    process.env.ENVIRONMENT = 'prod';
    expect(() => assertGcpProjectIdMatchesEnv('tenant-abcdef123-runtime')).not.toThrow();
  });

  it('accepts dev-suffixed manual project when ENVIRONMENT=dev', () => {
    process.env.ENVIRONMENT = 'dev';
    expect(() => assertGcpProjectIdMatchesEnv('tenant-acme-dev')).not.toThrow();
  });

  it('accepts runtime-dev provisioned project when ENVIRONMENT=dev', () => {
    process.env.ENVIRONMENT = 'dev';
    expect(() => assertGcpProjectIdMatchesEnv('tenant-abcdef123-runtime-dev')).not.toThrow();
  });

  it('rejects a dev project when ENVIRONMENT=prod', () => {
    process.env.ENVIRONMENT = 'prod';
    expect(() => assertGcpProjectIdMatchesEnv('tenant-acme-dev'))
      .toThrow(CrossEnvironmentGcpProjectError);
  });

  it('rejects a prod manual project when ENVIRONMENT=dev', () => {
    process.env.ENVIRONMENT = 'dev';
    expect(() => assertGcpProjectIdMatchesEnv('tenant-acme-prod'))
      .toThrow(CrossEnvironmentGcpProjectError);
  });

  it('rejects a prod provisioned project when ENVIRONMENT=dev', () => {
    process.env.ENVIRONMENT = 'dev';
    expect(() => assertGcpProjectIdMatchesEnv('tenant-abcdef123-runtime'))
      .toThrow(CrossEnvironmentGcpProjectError);
  });

  it('rejects a runtime-dev value when ENVIRONMENT=staging', () => {
    process.env.ENVIRONMENT = 'staging';
    expect(() => assertGcpProjectIdMatchesEnv('tenant-abcdef123-runtime-dev'))
      .toThrow(CrossEnvironmentGcpProjectError);
  });

  it('rejects a non-tenant project that happens to end in -prod', () => {
    process.env.ENVIRONMENT = 'prod';
    expect(() => assertGcpProjectIdMatchesEnv('platform-control-prod'))
      .toThrow(CrossEnvironmentGcpProjectError);
  });

  it('rejects when ENVIRONMENT is unset (fails closed)', () => {
    delete process.env.ENVIRONMENT;
    expect(() => assertGcpProjectIdMatchesEnv('tenant-acme-dev'))
      .toThrow(CrossEnvironmentGcpProjectError);
  });

  it('bypasses entirely when ENVIRONMENT=test (downstream test fixtures use mock values)', () => {
    process.env.ENVIRONMENT = 'test';
    // Any value, real or mock, is accepted as a no-op.
    expect(() => assertGcpProjectIdMatchesEnv('gcp-project-xyz')).not.toThrow();
    expect(() => assertGcpProjectIdMatchesEnv('tenant-acme-prod')).not.toThrow();
    expect(() => assertGcpProjectIdMatchesEnv('tenant-acme-dev')).not.toThrow();
    expect(() => assertGcpProjectIdMatchesEnv('')).not.toThrow();
  });

  it('CrossEnvironmentGcpProjectError carries diagnostic context', () => {
    process.env.ENVIRONMENT = 'prod';
    try {
      assertGcpProjectIdMatchesEnv('tenant-acme-dev');
      fail('expected throw');
    } catch (err) {
      expect(err).toBeInstanceOf(CrossEnvironmentGcpProjectError);
      const cee = err as CrossEnvironmentGcpProjectError;
      expect(cee.attempted).toBe('tenant-acme-dev');
      expect(cee.currentEnv).toBe('prod');
      expect(cee.derivedEnv).toBe('dev');
      expect(cee.message).toContain('tenant-acme-dev');
      expect(cee.message).toContain('prod');
      expect(cee.message).toContain('dev');
    }
  });
});
