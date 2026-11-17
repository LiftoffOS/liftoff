// B5 — fleet CSV parsing + per-tenant token resolution (skip on missing token, never fall back).

jest.mock('../../infrastructure/logging', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() } }));

import { parseFleetTenants, resolveFleetEndpoints, harnessUrlForRuntime, discoverFleetEndpoints } from '../fleet';

describe('parseFleetTenants', () => {
  it('parses tenantId=harnessUrl=tokenEnvName triples', () => {
    const csv = 't1=https://tr-1.run.app/api/internal/test-harness/run-agent=TR1_TOKEN,' +
                't2=https://tr-2.run.app/api/internal/test-harness/run-agent=TR2_TOKEN';
    expect(parseFleetTenants(csv)).toEqual([
      { tenantId: 't1', harnessUrl: 'https://tr-1.run.app/api/internal/test-harness/run-agent', tokenEnvName: 'TR1_TOKEN' },
      { tenantId: 't2', harnessUrl: 'https://tr-2.run.app/api/internal/test-harness/run-agent', tokenEnvName: 'TR2_TOKEN' },
    ]);
  });

  it('survives an "=" inside the harness URL (splits on first + last only)', () => {
    const csv = 't1=https://x.run.app/run-agent?foo=bar=TR1_TOKEN';
    expect(parseFleetTenants(csv)).toEqual([
      { tenantId: 't1', harnessUrl: 'https://x.run.app/run-agent?foo=bar', tokenEnvName: 'TR1_TOKEN' },
    ]);
  });

  it('returns empty for undefined/empty and skips malformed entries', () => {
    expect(parseFleetTenants(undefined)).toEqual([]);
    expect(parseFleetTenants('')).toEqual([]);
    // one good, one missing token part, one blank
    expect(parseFleetTenants('t1=url1=TOK1, t2=onlytwo, ,')).toEqual([
      { tenantId: 't1', harnessUrl: 'url1', tokenEnvName: 'TOK1' },
    ]);
  });
});

describe('resolveFleetEndpoints', () => {
  it('resolves each tenant token from its named env var', () => {
    const fleet = [
      { tenantId: 't1', harnessUrl: 'url1', tokenEnvName: 'TR1_TOKEN' },
      { tenantId: 't2', harnessUrl: 'url2', tokenEnvName: 'TR2_TOKEN' },
    ];
    const env = { TR1_TOKEN: 'secret-1', TR2_TOKEN: 'secret-2' } as NodeJS.ProcessEnv;
    expect(resolveFleetEndpoints(fleet, env)).toEqual([
      { tenantId: 't1', endpoint: { harnessUrl: 'url1', serviceToken: 'secret-1' } },
      { tenantId: 't2', endpoint: { harnessUrl: 'url2', serviceToken: 'secret-2' } },
    ]);
  });

  it('SKIPS a tenant whose token env is missing — never falls back to another token', () => {
    const fleet = [
      { tenantId: 't1', harnessUrl: 'url1', tokenEnvName: 'TR1_TOKEN' },
      { tenantId: 't2', harnessUrl: 'url2', tokenEnvName: 'TR2_MISSING' },
    ];
    const env = { TR1_TOKEN: 'secret-1' } as NodeJS.ProcessEnv;
    const resolved = resolveFleetEndpoints(fleet, env);
    expect(resolved).toEqual([{ tenantId: 't1', endpoint: { harnessUrl: 'url1', serviceToken: 'secret-1' } }]);
    // t2 is absent entirely — no endpoint borrowed t1's token.
    expect(resolved.find((r) => r.tenantId === 't2')).toBeUndefined();
  });
});

describe('harnessUrlForRuntime', () => {
  it('appends the test-harness run-agent path to a base runtime_url', () => {
    expect(harnessUrlForRuntime('https://agent-abc.run.app')).toBe(
      'https://agent-abc.run.app/api/internal/test-harness/run-agent',
    );
  });
  it('trims a trailing slash so the path is not doubled', () => {
    expect(harnessUrlForRuntime('https://agent-abc.run.app/')).toBe(
      'https://agent-abc.run.app/api/internal/test-harness/run-agent',
    );
  });
});

describe('discoverFleetEndpoints', () => {
  const realFetch = global.fetch;
  afterEach(() => { global.fetch = realFetch; jest.clearAllMocks(); });

  const baseEnv = { PLATFORM_BACKEND_URL: 'https://pb.example', DIAGNOSTICS_SERVICE_TOKEN: 'shared-secret' } as NodeJS.ProcessEnv;

  it('maps active tenants to run-agent harness endpoints using the shared token', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tenants: [
        { tenantId: 't1', runtimeUrl: 'https://agent-1.run.app' },
        { tenantId: 't2', runtimeUrl: 'https://agent-2.run.app/' },
      ] }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const out = await discoverFleetEndpoints(baseEnv);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://pb.example/api/internal/diagnostics/fleet-tenants',
      expect.objectContaining({ headers: expect.objectContaining({ 'X-Service-Auth': 'shared-secret' }) }),
    );
    expect(out).toEqual([
      { tenantId: 't1', endpoint: { harnessUrl: 'https://agent-1.run.app/api/internal/test-harness/run-agent', serviceToken: 'shared-secret' } },
      { tenantId: 't2', endpoint: { harnessUrl: 'https://agent-2.run.app/api/internal/test-harness/run-agent', serviceToken: 'shared-secret' } },
    ]);
  });

  it('returns [] (caller falls back to CSV) when PB URL or token is unset', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    expect(await discoverFleetEndpoints({ DIAGNOSTICS_SERVICE_TOKEN: 'x' } as NodeJS.ProcessEnv)).toEqual([]);
    expect(await discoverFleetEndpoints({ PLATFORM_BACKEND_URL: 'https://pb' } as NodeJS.ProcessEnv)).toEqual([]);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('returns [] on a non-200 from PB (graceful fallback, not a throw)', async () => {
    global.fetch = jest.fn().mockResolvedValue({ ok: false, status: 503 }) as unknown as typeof fetch;
    expect(await discoverFleetEndpoints(baseEnv)).toEqual([]);
  });

  it('returns [] when the fetch rejects (PB unreachable)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('ECONNREFUSED')) as unknown as typeof fetch;
    expect(await discoverFleetEndpoints(baseEnv)).toEqual([]);
  });

  it('drops rows missing a tenantId or runtimeUrl', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ tenants: [
        { tenantId: 't1', runtimeUrl: 'https://agent-1.run.app' },
        { tenantId: '', runtimeUrl: 'https://agent-2.run.app' },
        { tenantId: 't3', runtimeUrl: '' },
      ] }),
    }) as unknown as typeof fetch;
    const out = await discoverFleetEndpoints(baseEnv);
    expect(out.map((r) => r.tenantId)).toEqual(['t1']);
  });
});
