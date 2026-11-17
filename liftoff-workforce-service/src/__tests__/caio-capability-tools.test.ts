// CAIO capability_search / run_capability tool handlers: they POST to
// platform-backend's capability-first routes, pass the invoking user's account
// on run (tenant-key), and surface a backend error as a payload (never a throw).

jest.mock('../infrastructure/config', () => ({
  loadConfig: () => ({ PLATFORM_BACKEND_URL: 'https://pb.test', WORKFORCE_SERVICE_TOKEN: 'wf-tok' }),
}));
jest.mock('../infrastructure/service-auth', () => ({
  getServiceAuthHeaders: async () => ({ 'X-Service-Auth': 'wf-tok' }),
}));

import { capabilitySearchTool, datasetExtractTool, datasetListTool, datasetQueryTool, runCapabilityTool } from '../workforce-plans/tools/capability.js';
import type { WorkforcePlanToolContext } from '../workforce-plans/tools/types.js';

const ctx = { tenantId: 't1', accountId: 'acct-1', role: 'owner' } as unknown as WorkforcePlanToolContext;
const fetchMock = jest.fn();

function okResponse(body: unknown) {
  return { ok: true, status: 200, json: async () => body, text: async () => '' };
}

beforeEach(() => {
  jest.clearAllMocks();
  global.fetch = fetchMock as unknown as typeof fetch;
});

describe('CAIO capability tools', () => {
  it('capability_search posts the spec and returns the vendor-hidden rendering', async () => {
    fetchMock.mockResolvedValue(okResponse({ result: '- [Crypto data] get latest news (capabilityId: cap_x)' }));
    const out = await capabilitySearchTool.execute(
      { operation: 'get latest', entity: 'crypto news', mode: 'public_data', targetSystem: 'X' },
      ctx,
    );
    const [url, opts] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('https://pb.test/api/internal/capability-discovery');
    expect(JSON.parse(opts.body)).toMatchObject({ tenantId: 't1', accountId: 'acct-1', operation: 'get latest', entity: 'crypto news', mode: 'public_data', targetSystem: 'x' });
    expect(out).toEqual({ result: expect.stringContaining('capabilityId: cap_x') });
  });

  // The search is judged on the credentials the run would use, so the same
  // account that rides on run rides on search — from the context, never from
  // the model's arguments.
  it('capability_search posts the invoking account, and ignores one the model tries to supply', async () => {
    fetchMock.mockResolvedValue(okResponse({ result: 'ok' }));
    await capabilitySearchTool.execute({ operation: 'x', entity: 'y', mode: 'public_data', accountId: 'attacker' }, ctx);
    const [, opts] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(opts.body).accountId).toBe('acct-1');
  });

  it('run_capability rejects a missing capabilityId without calling the backend', async () => {
    const out = await runCapabilityTool.execute({ args: {} }, ctx);
    expect(out).toEqual({ error: expect.stringContaining('requires a capabilityId') });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  // A call runs with the arguments it was proposed with. Observed live: the
  // model put the ticker beside capabilityId, the tool sent `args: {}`, and
  // both candidates in the fallback chain refused "symbol is required".
  it.each([
    ['under `arguments` as an object', { capabilityId: 'cap_abc', arguments: { symbol: 'SHOP' } }],
    ['under `arguments` as a JSON string', { capabilityId: 'cap_abc', arguments: JSON.stringify({ symbol: 'SHOP' }) }],
    ['flattened beside capabilityId', { capabilityId: 'cap_abc', symbol: 'SHOP' }],
    ['under `args`', { capabilityId: 'cap_abc', args: { symbol: 'SHOP' } }],
  ])('run_capability reads the arguments %s', async (_shape, input) => {
    fetchMock.mockResolvedValue(okResponse({ result: 'ok' }));
    await runCapabilityTool.execute(input as Record<string, unknown>, ctx);
    const [, opts] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(opts.body).args).toEqual({ symbol: 'SHOP' });
  });

  it('run_capability reads no arguments from a string that is not a JSON object, rather than guessing', async () => {
    fetchMock.mockResolvedValue(okResponse({ result: 'ok' }));
    await runCapabilityTool.execute({ capabilityId: 'cap_abc', arguments: 'SHOP' }, ctx);
    const [, opts] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(opts.body).args).toEqual({});
  });

  it('run_capability posts the invoking account (tenant-key) and returns the result', async () => {
    fetchMock.mockResolvedValue(okResponse({ result: '{"items":[]}' }));
    const out = await runCapabilityTool.execute({ capabilityId: 'cap_abc', args: { q: 'x' } }, ctx);
    const [url, opts] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('https://pb.test/api/internal/capability-discovery/run');
    expect(JSON.parse(opts.body)).toEqual({ tenantId: 't1', accountId: 'acct-1', capabilityId: 'cap_abc', args: { q: 'x' } });
    expect(out).toEqual({ result: '{"items":[]}' });
  });

  it('surfaces a backend error as a payload, not a throw', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 500, text: async () => 'boom', json: async () => ({}) });
    const out = await runCapabilityTool.execute({ capabilityId: 'cap_abc', args: {} }, ctx);
    expect(out).toMatchObject({ error: expect.stringContaining('HTTP 500') });
  });
});

// A large result is parked for THIS thread, and the dataset tools read it back
// for the same thread; a turn without a thread parks and reads unscoped.
describe('CAIO dataset tools', () => {
  const threadCtx = { tenantId: 't1', accountId: 'acct-1', role: 'owner', threadId: 'th-9' } as unknown as WorkforcePlanToolContext;

  it('run_capability names the thread as the job, and the dataset to add to', async () => {
    fetchMock.mockResolvedValue(okResponse({ result: 'kept as dataset …' }));
    await runCapabilityTool.execute({ capabilityId: 'cap_abc', args: { q: 'x' }, appendTo: '2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11' }, threadCtx);
    const [, opts] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(JSON.parse(opts.body)).toEqual({
      tenantId: 't1', accountId: 'acct-1', capabilityId: 'cap_abc', args: { q: 'x' },
      scopeKind: 'caio_thread', scopeId: 'th-9', appendTo: '2f6f2a2e-0d4c-4e0e-9a6e-2c6b7f3f1a11',
    });
  });

  it('each dataset tool posts the model\'s input for the thread and returns the text', async () => {
    fetchMock.mockResolvedValue(okResponse({ result: 'rows…' }));
    const out = await datasetQueryTool.execute({ datasetId: 'x', select: ['title'] }, threadCtx);
    expect(out).toEqual({ result: 'rows…' });
    const [url, opts] = fetchMock.mock.calls[0] as [string, { body: string }];
    expect(url).toBe('https://pb.test/api/internal/capability-discovery/datasets/tool');
    expect(JSON.parse(opts.body)).toEqual({ tenantId: 't1', tool: 'dataset_query', input: { datasetId: 'x', select: ['title'] }, scopeKind: 'caio_thread', scopeId: 'th-9' });
    await datasetExtractTool.execute({ datasetId: 'x', instruction: 'themes' }, ctx);
    expect(JSON.parse((fetchMock.mock.calls[1] as [string, { body: string }])[1].body)).toEqual({ tenantId: 't1', tool: 'dataset_extract', input: { datasetId: 'x', instruction: 'themes' } });
    await datasetListTool.execute({}, threadCtx);
    expect(JSON.parse((fetchMock.mock.calls[2] as [string, { body: string }])[1].body)).toEqual({ tenantId: 't1', tool: 'dataset_list', input: {}, scopeKind: 'caio_thread', scopeId: 'th-9' });
  });

  it('the three definitions name no vendor and no inner term', () => {
    for (const t of [datasetQueryTool, datasetExtractTool, datasetListTool]) {
      expect(t.definition.description.toLowerCase()).not.toMatch(/\b(agent|vendor|tenant|jsonb|sql)\b/);
    }
  });
});
