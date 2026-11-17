// INV-PB-009 — runtime -> control-plane agent id translation.
//
// The properties that matter operationally: translation is identity-preserving
// for ids that are already internal (so it is safe on a mixed feed and
// idempotent), and a runtime outage degrades to pass-through rather than
// mis-keying or dropping attribution.

import { jest } from '@jest/globals';

const fetchWithOidc = jest.fn();
jest.mock('../../infrastructure/oidc-fetch', () => ({ fetchWithOidc }));
// getRuntimeToInternalMap resolves the runtime URL itself — tenants.runtime_url
// can be NULL, so passing the column directly would translate nothing.
const resolveRuntimeBaseUrl = jest.fn(async () => RUNTIME_URL);
jest.mock('../../connectors/tenant-runtime-url', () => ({ resolveRuntimeBaseUrl }));
jest.mock('../../infrastructure/logging', () => ({
  log: { warn: jest.fn(), info: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

import {
  getRuntimeToInternalMap,
  toInternalAgentId,
  NO_AGENT_SENTINEL,
  fetchAgentIdMappings,
  __resetAgentIdMapCache,
} from '../runtime-agent-id-map';

const TENANT = 'dd7d80bd-3b77-4677-817c-053fdb8668cd';
const RUNTIME_URL = 'https://agent-service.example.run.app';

// Realistic UUID values, so the fixture stays honest about the shape.
const RUNTIME_ID = '577a520f-a645-4e68-bfaa-5e47388572b5';
const INTERNAL_ID = 'c6f1b7de-02de-47bd-83df-a18ec455ad11';

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body };
}

beforeEach(() => {
  __resetAgentIdMapCache();
  fetchWithOidc.mockReset();
  resolveRuntimeBaseUrl.mockReset();
  resolveRuntimeBaseUrl.mockResolvedValue(RUNTIME_URL as never);
});

describe('getRuntimeToInternalMap', () => {
  it('builds a runtime -> internal lookup from /list-mappings', async () => {
    fetchWithOidc.mockResolvedValue(okResponse([
      { internalAgentId: INTERNAL_ID, runtimeAgentId: RUNTIME_ID, name: 'Daily Metrics Reporter' },
    ]) as never);

    const map = await getRuntimeToInternalMap(TENANT);
    expect(map.get(RUNTIME_ID)).toBe(INTERNAL_ID);
  });

  it('caches per tenant — a second call does not re-fetch', async () => {
    fetchWithOidc.mockResolvedValue(okResponse([
      { internalAgentId: INTERNAL_ID, runtimeAgentId: RUNTIME_ID },
    ]) as never);

    await getRuntimeToInternalMap(TENANT);
    await getRuntimeToInternalMap(TENANT);
    expect(fetchWithOidc).toHaveBeenCalledTimes(1);
  });

  it('serves the last good map when the runtime becomes unreachable', async () => {
    fetchWithOidc.mockResolvedValueOnce(okResponse([
      { internalAgentId: INTERNAL_ID, runtimeAgentId: RUNTIME_ID },
    ]) as never);
    await getRuntimeToInternalMap(TENANT);

    // Expire the TTL, then fail the refresh.
    jest.spyOn(Date, 'now').mockReturnValue(Date.now() + 10 * 60 * 1000);
    fetchWithOidc.mockRejectedValueOnce(new Error('ECONNREFUSED') as never);

    const map = await getRuntimeToInternalMap(TENANT);
    expect(map.get(RUNTIME_ID)).toBe(INTERNAL_ID);
    jest.spyOn(Date, 'now').mockRestore();
  });

  it('still translates when tenants.runtime_url is NULL (resolver falls back to env)', async () => {
    // The column can be NULL for every tenant. Reading it directly would yield
    // an empty map and silently translate nothing.
    fetchWithOidc.mockResolvedValue(okResponse([
      { internalAgentId: INTERNAL_ID, runtimeAgentId: RUNTIME_ID },
    ]) as never);
    const map = await getRuntimeToInternalMap(TENANT);
    expect(map.get(RUNTIME_ID)).toBe(INTERNAL_ID);
  });

  it('returns a pass-through map when the runtime URL cannot be resolved', async () => {
    resolveRuntimeBaseUrl.mockRejectedValueOnce(new Error('no url') as never);
    const map = await getRuntimeToInternalMap(TENANT);
    expect(map.size).toBe(0);
  });

  it('returns an empty map on a non-2xx with no prior good map', async () => {
    fetchWithOidc.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as never);
    const map = await getRuntimeToInternalMap(TENANT);
    expect(map.size).toBe(0);
  });
});

describe('toInternalAgentId', () => {
  const map = new Map([[RUNTIME_ID, INTERNAL_ID]]);

  it('translates a runtime id', () => {
    expect(toInternalAgentId(map, RUNTIME_ID)).toBe(INTERNAL_ID);
  });

  it('is identity for an id that is already internal', () => {
    expect(toInternalAgentId(map, INTERNAL_ID)).toBe(INTERNAL_ID);
  });

  it('is idempotent — re-applying does not double-translate', () => {
    const once = toInternalAgentId(map, RUNTIME_ID);
    expect(toInternalAgentId(map, once)).toBe(INTERNAL_ID);
  });

  it('is identity for an unknown id rather than dropping it', () => {
    expect(toInternalAgentId(map, 'unknown-id')).toBe('unknown-id');
  });

  it('preserves null (an unattributed event stays unattributed)', () => {
    expect(toInternalAgentId(map, null)).toBeNull();
    expect(toInternalAgentId(map, undefined)).toBeNull();
  });

  it('passes everything through when the map is empty (runtime unreachable)', () => {
    expect(toInternalAgentId(new Map(), RUNTIME_ID)).toBe(RUNTIME_ID);
  });

  // The runtime's agents column is NOT NULL, so a platform assistant's session
  // travels as the nil UUID. It is not an agent id, and a cost row carrying it
  // reads as an agent the workspace does not have. The rule lived at ONE
  // call site (the web-tool spend subscriber) while the backstop ingester used
  // the same translator and kept writing it, so the same browser session
  // booked differently down the two paths.
  it('the no-agent sentinel is not an agent, on every path through here', () => {
    expect(toInternalAgentId(new Map(), NO_AGENT_SENTINEL)).toBeNull();
    // Even when a map happens to contain it — the sentinel wins, so a stray
    // mapping cannot resurrect a phantom agent.
    const poisoned = new Map([[NO_AGENT_SENTINEL, INTERNAL_ID]]);
    expect(toInternalAgentId(poisoned, NO_AGENT_SENTINEL)).toBeNull();
  });
});

describe('fetchAgentIdMappings', () => {
  it('returns null (unknown), not [], when the runtime is unreachable', async () => {
    fetchWithOidc.mockRejectedValue(new Error('boom') as never);
    await expect(fetchAgentIdMappings(TENANT, RUNTIME_URL)).resolves.toBeNull();
  });

  it('distinguishes an empty tenant from an unreachable one', async () => {
    fetchWithOidc.mockResolvedValue(okResponse([]) as never);
    await expect(fetchAgentIdMappings(TENANT, RUNTIME_URL)).resolves.toEqual([]);
  });
});
