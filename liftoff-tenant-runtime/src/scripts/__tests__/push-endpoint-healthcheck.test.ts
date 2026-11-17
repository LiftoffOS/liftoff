// Tests for push-endpoint-healthcheck. Mocks v1.SubscriberClient.listSubscriptions
// and global fetch. Verifies exit code and pass/fail classification per the
// scenarios in the implementation plan.

const listSubscriptionsMock = jest.fn();
const getIdTokenClientMock = jest.fn();
const getRequestHeadersMock = jest.fn().mockResolvedValue({ Authorization: 'Bearer fake-oidc-token' });

jest.mock('@google-cloud/pubsub', () => ({
  v1: {
    SubscriberClient: jest.fn().mockImplementation(() => ({
      projectPath: (p: string) => `projects/${p}`,
      listSubscriptions: listSubscriptionsMock,
    })),
  },
}));

jest.mock('google-auth-library', () => ({
  GoogleAuth: jest.fn().mockImplementation(() => ({
    getIdTokenClient: getIdTokenClientMock,
  })),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
  log: { info: jest.fn(), error: jest.fn(), warn: jest.fn() },
}));

describe('push-endpoint-healthcheck', () => {
  const originalEnv = process.env;
  let exitSpy: jest.SpyInstance;
  let fetchSpy: jest.SpyInstance;

  beforeEach(() => {
    jest.resetModules();
    listSubscriptionsMock.mockReset();
    getIdTokenClientMock.mockReset();
    getIdTokenClientMock.mockResolvedValue({ getRequestHeaders: getRequestHeadersMock });
    process.env = { ...originalEnv, TENANT_PROJECT: 'tenant-test-dev', ENVIRONMENT: 'dev' };
    exitSpy = jest.spyOn(process, 'exit').mockImplementation(((_code?: number) => undefined) as never);
    fetchSpy = jest.spyOn(global, 'fetch' as never);
  });

  afterEach(() => {
    exitSpy.mockRestore();
    fetchSpy.mockRestore();
    process.env = originalEnv;
  });

  it('exits 1 when a subscription points at placeholder.invalid', async () => {
    listSubscriptionsMock.mockResolvedValue([[
      {
        name: 'projects/tenant-test-dev/subscriptions/control-plane-events-dev-coordinator-push',
        pushConfig: {
          pushEndpoint: 'https://placeholder.invalid/internal/pubsub/control-plane-events',
          oidcToken: { audience: 'https://placeholder.invalid' },
        },
      },
    ]]);
    const { main } = await import('../push-endpoint-healthcheck');
    await main();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('passes when endpoint, audience, and healthz all OK', async () => {
    listSubscriptionsMock.mockResolvedValue([[
      {
        name: 'projects/tenant-test-dev/subscriptions/control-plane-events-dev-coordinator-push',
        pushConfig: {
          pushEndpoint: 'https://coordinator-service-abc-uw.a.run.app/internal/pubsub/control-plane-events',
          oidcToken: { audience: 'https://coordinator-service-abc-uw.a.run.app' },
        },
      },
    ]]);
    fetchSpy.mockResolvedValue({ ok: true, status: 200 } as never);
    const { main } = await import('../push-endpoint-healthcheck');
    await main();
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it('exits 1 on mismatched audience', async () => {
    listSubscriptionsMock.mockResolvedValue([[
      {
        name: 'projects/tenant-test-dev/subscriptions/control-plane-events-dev-coordinator-push',
        pushConfig: {
          pushEndpoint: 'https://coordinator-service-B-uw.a.run.app/internal/pubsub/control-plane-events',
          oidcToken: { audience: 'https://coordinator-service-A-uw.a.run.app' },
        },
      },
    ]]);
    const { main } = await import('../push-endpoint-healthcheck');
    await main();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('exits 1 when healthz times out', async () => {
    listSubscriptionsMock.mockResolvedValue([[
      {
        name: 'projects/tenant-test-dev/subscriptions/control-plane-events-dev-coordinator-push',
        pushConfig: {
          pushEndpoint: 'https://coordinator-service-abc-uw.a.run.app/internal/pubsub/control-plane-events',
          oidcToken: { audience: 'https://coordinator-service-abc-uw.a.run.app' },
        },
      },
    ]]);
    fetchSpy.mockRejectedValue(new Error('aborted'));
    const { main } = await import('../push-endpoint-healthcheck');
    await main();
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it('sends an OIDC bearer token whose audience matches the coordinator origin', async () => {
    listSubscriptionsMock.mockResolvedValue([[
      {
        name: 'projects/tenant-test-dev/subscriptions/control-plane-events-dev-coordinator-push',
        pushConfig: {
          pushEndpoint: 'https://coordinator-service-abc-uw.a.run.app/internal/pubsub/control-plane-events',
          oidcToken: { audience: 'https://coordinator-service-abc-uw.a.run.app' },
        },
      },
    ]]);
    fetchSpy.mockResolvedValue({ ok: true, status: 200 } as never);
    const { main } = await import('../push-endpoint-healthcheck');
    await main();
    expect(getIdTokenClientMock).toHaveBeenCalledWith('https://coordinator-service-abc-uw.a.run.app');
    const lastCall = fetchSpy.mock.calls[fetchSpy.mock.calls.length - 1];
    const headers = (lastCall[1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer fake-oidc-token');
  });

  it('skips subscriptions whose name does not match the coordinator-push pattern', async () => {
    listSubscriptionsMock.mockResolvedValue([[
      {
        name: 'projects/tenant-test-dev/subscriptions/governance-events-dev-sub',
        pushConfig: {
          pushEndpoint: 'https://placeholder.invalid/foo',
          oidcToken: { audience: 'https://placeholder.invalid' },
        },
      },
    ]]);
    const { main } = await import('../push-endpoint-healthcheck');
    await main();
    expect(exitSpy).not.toHaveBeenCalled();
  });
});
