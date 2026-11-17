// WarpClient list() tests using the REAL Warp response shapes:
//   • standard list endpoints return { hasMore, count, data[] } (cursor pagination)
//   • custom-worker-fields / worker-custom-field-values return BARE ARRAYS (no envelope)
//   • time-off balances carry legacyWorkerId (NOT the wrk_ id) → fan-out per worker
// These exercise exactly the paths the earlier mapper-only tests missed.
import { WarpClient } from '../warp.js';
import type { ConnectorCredentials } from '../types.js';

interface Call { url: string; method: string }
function mockFetch(routes: Array<{ match: RegExp; json: unknown }>) {
  const calls: Call[] = [];
  (global as unknown as { fetch: unknown }).fetch = jest.fn(async (url: string, init?: { method?: string }) => {
    calls.push({ url, method: init?.method ?? 'GET' });
    const r = routes.find((x) => x.match.test(url));
    return { ok: true, status: 200, headers: { get: () => null }, json: async () => r?.json ?? {}, text: async () => '' } as unknown as Response;
  });
  return calls;
}
const cp = () => async () => ({ connectorConfig: { apiKey: 'k' } } as unknown as ConnectorCredentials);

describe('WarpClient.list', () => {
  it('standard endpoint: extracts { data } + cursor-paginates via afterId', async () => {
    mockFetch([{ match: /\/v1\/departments/, json: { hasMore: true, count: 2, data: [{ id: 'dpt_1', name: 'Eng' }, { id: 'dpt_2', name: 'Ops' }] } }]);
    const res = await new WarpClient(cp()).list('warp_departments', {});
    expect(res.records.map((r) => r.id)).toEqual(['dpt_1', 'dpt_2']);
    expect(res.hasMore).toBe(true);
    expect(res.nextPageToken).toBe('dpt_2'); // afterId = last id
  });

  it('BARE ARRAY endpoint (custom fields): extracts rows from the array, no pagination', async () => {
    const calls = mockFetch([
      { match: /\/v1\/custom-worker-fields$/, json: [{ id: 'cwf_salary', name: 'Salary', category: 'compensation', type: 'currency' }] },
      { match: /\/v1\/worker-custom-field-values/, json: [{ id: 'v_1', workerId: 'wrk_1', fieldId: 'cwf_salary', value: { type: 'currency', amount: 120000, currencyCode: 'USD' } }] },
    ]);
    const res = await new WarpClient(cp()).list('warp_custom_field_values', {});
    expect(res.records).toHaveLength(1);            // would be 0 with the old body.data bug
    expect(res.hasMore).toBe(false);
    // enriched from the (bare-array) definitions
    expect(res.records[0].data).toMatchObject({ fieldCategory: 'compensation', fieldName: 'Salary', fieldType: 'currency' });
    expect(calls.some((c) => /custom-worker-fields$/.test(c.url))).toBe(true); // defs were fetched
  });

  it('balances: fans out per worker and stamps the wrk_ id + policy unit', async () => {
    const calls = mockFetch([
      { match: /\/v1\/workers/, json: { hasMore: false, data: [{ id: 'wrk_1' }, { id: 'wrk_2' }] } },
      { match: /\/v1\/time_off\/policies/, json: { hasMore: false, data: [{ id: 'top_1', unit: 'day' }] } },
      { match: /\/v1\/time_off\/balances\?workerIds=wrk_1/, json: { hasMore: false, data: [{ id: 'bal_1', policyId: 'top_1', legacyWorkerId: 'legacy-1', available: 5 }] } },
      { match: /\/v1\/time_off\/balances\?workerIds=wrk_2/, json: { hasMore: false, data: [{ id: 'bal_2', policyId: 'top_1', legacyWorkerId: 'legacy-2', available: 3 }] } },
    ]);
    const res = await new WarpClient(cp()).list('warp_time_off_balances', {});
    expect(res.records).toHaveLength(2);
    expect(res.records[0].data).toMatchObject({ workerId: 'wrk_1', policyUnit: 'day' }); // recovered link + unit
    expect(res.records[1].data).toMatchObject({ workerId: 'wrk_2', policyUnit: 'day' });
    expect(calls.some((c) => /balances\?workerIds=wrk_1/.test(c.url))).toBe(true);
  });

  it('sends x-api-key from connectorConfig.apiKey', async () => {
    const spy = jest.fn((_url: string, _init?: { headers?: Record<string, string> }) =>
      Promise.resolve({ ok: true, status: 200, headers: { get: () => null }, json: async () => ({ data: [] }), text: async () => '' } as unknown as Response));
    (global as unknown as { fetch: unknown }).fetch = spy;
    await new WarpClient(cp()).list('warp_departments', {});
    expect(spy.mock.calls[0]?.[1]?.headers?.['x-api-key']).toBe('k');
  });
});
