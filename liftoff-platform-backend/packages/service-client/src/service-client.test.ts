import { ServiceClient } from './service-client.js';
import { CircuitBreaker } from './circuit-breaker.js';

function mockFetch(status = 200, body: unknown = { ok: true }): jest.Mock {
  return jest.fn(async (_url: URL | RequestInfo, _init?: RequestInit) => {
    void _url;
    void _init;
    return new Response(JSON.stringify(body), { status });
  });
}

describe('ServiceClient.resolveTargetUrl', () => {
  it('caches the resolved URL for TTL', async () => {
    const resolver = jest.fn(async () => 'https://tenant-abc.example.com');
    const client = new ServiceClient({
      resolveTargetUrl: resolver,
      resolveTargetUrlTtlMs: 60_000,
    });

    expect(await client.resolveTargetUrl('tenant-a')).toBe('https://tenant-abc.example.com');
    expect(await client.resolveTargetUrl('tenant-a')).toBe('https://tenant-abc.example.com');
    expect(resolver).toHaveBeenCalledTimes(1);
  });

  it('re-resolves when TTL is 0', async () => {
    const resolver = jest.fn(async () => 'https://tenant.example.com');
    const client = new ServiceClient({
      resolveTargetUrl: resolver,
      resolveTargetUrlTtlMs: 0,
    });
    await client.resolveTargetUrl('t');
    await client.resolveTargetUrl('t');
    expect(resolver).toHaveBeenCalledTimes(2);
  });

  it('invalidateUrl clears the cached entry', async () => {
    const resolver = jest.fn(async () => 'https://t.example.com');
    const client = new ServiceClient({
      resolveTargetUrl: resolver,
      resolveTargetUrlTtlMs: 60_000,
    });
    await client.resolveTargetUrl('t');
    client.invalidateUrl('t');
    await client.resolveTargetUrl('t');
    expect(resolver).toHaveBeenCalledTimes(2);
  });
});

describe('ServiceClient.buildHeaders', () => {
  const ORIG_TOKEN = process.env.TENANT_RUNTIME_SERVICE_TOKEN;
  afterEach(() => {
    if (ORIG_TOKEN === undefined) delete process.env.TENANT_RUNTIME_SERVICE_TOKEN;
    else process.env.TENANT_RUNTIME_SERVICE_TOKEN = ORIG_TOKEN;
  });

  it('includes Content-Type and default headers (keys lowercased)', async () => {
    const client = new ServiceClient({
      resolveTargetUrl: async () => 'https://t.example.com',
      defaultHeaders: { 'X-Tenant-Id': 'tenant-a' },
    });
    const headers = await client.buildHeaders('https://t.example.com');
    expect(headers['content-type']).toBe('application/json');
    expect(headers['x-tenant-id']).toBe('tenant-a');
    // Critical invariant — no duplicate capitalized variant. If both
    // 'Content-Type' and 'content-type' end up in the map, node's fetch
    // emits a comma-joined value that express.json silently refuses to
    // parse. Regression guard for WS-C.
    expect(headers['Content-Type']).toBeUndefined();
  });

  it('adds X-Service-Auth from env when configured', async () => {
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'shared-secret';
    const client = new ServiceClient({
      serviceAuthEnvVar: 'TENANT_RUNTIME_SERVICE_TOKEN',
      resolveTargetUrl: async () => 'https://t.example.com',
    });
    const headers = await client.buildHeaders('https://t.example.com');
    expect(headers['x-service-auth']).toBe('shared-secret');
  });

  it('omits X-Service-Auth when env var is unset', async () => {
    delete process.env.TENANT_RUNTIME_SERVICE_TOKEN;
    const client = new ServiceClient({
      serviceAuthEnvVar: 'TENANT_RUNTIME_SERVICE_TOKEN',
      resolveTargetUrl: async () => 'https://t.example.com',
    });
    const headers = await client.buildHeaders('https://t.example.com');
    expect(headers['x-service-auth']).toBeUndefined();
  });

  it('extra headers win over defaults', async () => {
    const client = new ServiceClient({
      resolveTargetUrl: async () => 'https://t.example.com',
      defaultHeaders: { 'Content-Type': 'application/json' },
    });
    const headers = await client.buildHeaders('https://t.example.com', {
      'Content-Type': 'text/plain',
    });
    expect(headers['content-type']).toBe('text/plain');
  });

  it('WS-C regression: caller Content-Type does NOT coexist with default content-type', async () => {
    // The bug: callers passing `headers: { 'Content-Type': 'application/json' }`
    // via fetch() arrive in buildHeaders as `extra: { 'content-type': ... }`
    // (because node's `new Headers()` lowercases keys). Before the fix, the
    // default 'Content-Type' (Capitalized) and the extra 'content-type'
    // (lowercase) both ended up in the merged object, and node's fetch
    // emitted them as a single comma-joined header value, which express.json
    // refuses to parse — leaving req.body silently empty.
    const client = new ServiceClient({
      resolveTargetUrl: async () => 'https://t.example.com',
    });
    const headers = await client.buildHeaders('https://t.example.com', {
      'content-type': 'application/json', // what `new Headers()` produces
    });
    const ctKeys = Object.keys(headers).filter(k => k.toLowerCase() === 'content-type');
    expect(ctKeys).toEqual(['content-type']);
    expect(headers['content-type']).toBe('application/json');
  });
});

describe('ServiceClient.fetch', () => {
  it('prepends the resolved base URL to the path', async () => {
    const impl = mockFetch();
    const client = new ServiceClient({
      resolveTargetUrl: async () => 'https://t.example.com',
      fetchImpl: impl as unknown as typeof fetch,
    });
    await client.fetch('t', '/api/hello', { method: 'GET' });
    expect(impl.mock.calls[0][0]).toBe('https://t.example.com/api/hello');
  });

  it('honours breakerKey and uses fallback when circuit is open', async () => {
    const breaker = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 60_000 });
    const impl = jest.fn(async () => {
      throw new Error('network');
    });
    const client = new ServiceClient({
      resolveTargetUrl: async () => 'https://t.example.com',
      breaker,
      fetchImpl: impl as typeof fetch,
    });

    // Trip circuit
    const firstFallback = new Response(null, { status: 503 });
    const r1 = await client.fetch('t', '/api/x', {
      breakerKey: 't:foo',
      breakerFallback: firstFallback,
    });
    expect(r1).toBe(firstFallback);
    expect(impl).toHaveBeenCalledTimes(1);

    // Next call short-circuits — fetch NOT invoked again
    const secondFallback = new Response(null, { status: 503 });
    await client.fetch('t', '/api/x', {
      breakerKey: 't:foo',
      breakerFallback: secondFallback,
    });
    expect(impl).toHaveBeenCalledTimes(1);
  });

  it('calls the onLog hook with redacted headers + URL on error', async () => {
    const onLog = jest.fn();
    const impl = jest.fn(async () => {
      throw new Error('oops');
    });
    const client = new ServiceClient({
      serviceAuthEnvVar: 'TENANT_RUNTIME_SERVICE_TOKEN',
      resolveTargetUrl: async () => 'https://t.example.com',
      onLog,
      fetchImpl: impl as typeof fetch,
    });
    process.env.TENANT_RUNTIME_SERVICE_TOKEN = 'secret-xyz';

    await expect(
      client.fetch('t', '/api/x?access_token=sec', { method: 'GET' }),
    ).rejects.toThrow('oops');

    const errorCall = onLog.mock.calls.find((c) => c[0] === 'error');
    expect(errorCall).toBeDefined();
    const ctx = errorCall![1] as Record<string, unknown>;
    expect(ctx.url as string).toContain('access_token=%5BREDACTED%5D');
    const headers = ctx.headers as Record<string, string>;
    expect(headers['x-service-auth']).toBe('[REDACTED]');
    delete process.env.TENANT_RUNTIME_SERVICE_TOKEN;
  });
});
