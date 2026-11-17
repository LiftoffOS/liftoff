// Unit tests for validate-tenant-runtime-urls. Mocks the DB pool,
// @google-cloud/run ServicesClient, fetchWithOidc, and writeCustomMetric.

const withAdminScopeMock = jest.fn();
const fetchWithOidcMock = jest.fn();
const writeCustomMetricMock = jest.fn();
const listServicesMock = jest.fn();

jest.mock('../../infrastructure/database', () => ({
  withAdminScope: withAdminScopeMock,
  initDatabase: jest.fn(),
  closePools: jest.fn(),
}));

jest.mock('../../infrastructure/secrets', () => ({
  initSecrets: jest.fn(),
}));

jest.mock('../../infrastructure/oidc-fetch', () => ({
  fetchWithOidc: fetchWithOidcMock,
}));

jest.mock('../../infrastructure/monitoring', () => ({
  writeCustomMetric: writeCustomMetricMock,
}));

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

jest.mock('@google-cloud/run', () => ({
  v2: {
    ServicesClient: jest.fn().mockImplementation(() => ({
      listServices: listServicesMock,
    })),
  },
}));

const TENANT = {
  id: 'dd7d80bd-3b77-4677-817c-053fdb8668cd',
  runtime_url: 'https://agent-service-abc123xyz-uw.a.run.app',
  gcp_project_id: 'tenant-acme-prod',
};

beforeEach(() => {
  jest.resetAllMocks();
});

it('emits invalid=0 when runtime_url matches and /healthz returns 2xx', async () => {
  withAdminScopeMock.mockImplementationOnce(async (_ctx: unknown, fn: (c: { query: jest.Mock }) => Promise<unknown>) => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [TENANT] }) };
    return fn(client);
  });
  listServicesMock.mockResolvedValue([[
    { name: `projects/${TENANT.gcp_project_id}/locations/us-west1/services/agent-service`, uri: TENANT.runtime_url },
  ]]);
  fetchWithOidcMock.mockResolvedValue({ ok: true, status: 200 });

  const { runValidation } = await import('../validate-tenant-runtime-urls');
  const summary = await runValidation();

  expect(summary).toEqual({ tenantCount: 1, invalidCount: 0 });
  expect(writeCustomMetricMock).toHaveBeenCalledWith(expect.objectContaining({
    metricType: 'custom.googleapis.com/liftoff/tenants/runtime_url_invalid',
    labels: { tenant_id: TENANT.id, gcp_project_id: TENANT.gcp_project_id },
    value: 0,
  }));
});

it('emits invalid=1 when runtime_url is stale', async () => {
  withAdminScopeMock.mockImplementationOnce(async (_ctx: unknown, fn: (c: { query: jest.Mock }) => Promise<unknown>) => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [TENANT] }) };
    return fn(client);
  });
  listServicesMock.mockResolvedValue([[
    { name: `projects/${TENANT.gcp_project_id}/locations/us-west1/services/agent-service`,
      uri: 'https://agent-service-different-uw.a.run.app' },
  ]]);

  const { runValidation } = await import('../validate-tenant-runtime-urls');
  const summary = await runValidation();

  expect(summary.invalidCount).toBe(1);
  expect(writeCustomMetricMock).toHaveBeenCalledWith(expect.objectContaining({
    value: 1,
  }));
  // Probe must not be attempted if the URL is already known bad.
  expect(fetchWithOidcMock).not.toHaveBeenCalled();
});

it('emits invalid=1 when listServices throws', async () => {
  withAdminScopeMock.mockImplementationOnce(async (_ctx: unknown, fn: (c: { query: jest.Mock }) => Promise<unknown>) => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [TENANT] }) };
    return fn(client);
  });
  listServicesMock.mockRejectedValue(new Error('PERMISSION_DENIED'));

  const { runValidation } = await import('../validate-tenant-runtime-urls');
  const summary = await runValidation();
  expect(summary.invalidCount).toBe(1);
});

it('emits invalid=1 when /healthz returns non-2xx', async () => {
  withAdminScopeMock.mockImplementationOnce(async (_ctx: unknown, fn: (c: { query: jest.Mock }) => Promise<unknown>) => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [TENANT] }) };
    return fn(client);
  });
  listServicesMock.mockResolvedValue([[
    { name: `projects/${TENANT.gcp_project_id}/locations/us-west1/services/agent-service`, uri: TENANT.runtime_url },
  ]]);
  fetchWithOidcMock.mockResolvedValue({ ok: false, status: 503 });

  const { runValidation } = await import('../validate-tenant-runtime-urls');
  const summary = await runValidation();
  expect(summary.invalidCount).toBe(1);
});

it('emits invalid=1 when agent-service is not present in the project', async () => {
  withAdminScopeMock.mockImplementationOnce(async (_ctx: unknown, fn: (c: { query: jest.Mock }) => Promise<unknown>) => {
    const client = { query: jest.fn().mockResolvedValue({ rows: [TENANT] }) };
    return fn(client);
  });
  listServicesMock.mockResolvedValue([[
    { name: `projects/${TENANT.gcp_project_id}/locations/us-west1/services/coordinator-service`,
      uri: 'https://coordinator-service-x-uw.a.run.app' },
  ]]);

  const { runValidation } = await import('../validate-tenant-runtime-urls');
  const summary = await runValidation();
  expect(summary.invalidCount).toBe(1);
});
