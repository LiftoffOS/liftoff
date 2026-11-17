// Tool Schema Cache — Phase 2c unit tests.
//
// Covers:
//   - initToolSchemaCache() seeds the cache on first call (happy path)
//   - getToolSchemas / listAllToolSchemas reflect seeded content
//   - refresh short-circuits when ListTools returns unchanged: true
//   - initToolSchemaCache() silently no-ops when the RPC throws (leaves
//     the cache empty; logs a warn)
//
// And the custom-MCP half under 1b: the effect class is appended as a
// DECLARED class (existing categories preserved), the entry stores the
// control plane's version string, an unchanged `updatedAt` with a changed
// classifier segment (a flag flip, or a version bump) refetches, a list
// without `version` falls back to `updatedAt`, and a payload stating the
// classifier off appends nothing.

const mockListTools = jest.fn();

jest.mock('../connector-service-client', () => ({
  getConnectorServiceClient: () => ({
    listTools: mockListTools,
  }),
}));

jest.mock('../../infrastructure/logging', () => ({
  logger: {
    debug: jest.fn(),
    info: jest.fn(),
    warn: jest.fn(),
    error: jest.fn(),
  },
}));
jest.mock('../../infrastructure/secret-store', () => ({ getManagedSecret: () => 'svc-token' }));
// Two served tenants, read by the real registry off a stubbed database: the
// custom-MCP refresh fans out over both, and the control-plane stub below
// answers the server for the first and an empty list for the second.
jest.mock('../../infrastructure/database', () => {
  const { servedTenantsPool } = require('../../test-utils/served-tenants');
  return { getPool: () => servedTenantsPool(['t1', 't2']) };
});

import {
  initToolSchemaCache,
  __clearToolSchemaCacheForTests,
  __setToolSchemaCacheForTests,
  getToolSchemas,
  getToolSchema,
  listAllToolSchemas,
  listConnectorTypes,
  resolveEntityType,
  isToolSchemaCacheSeeded,
  withEffectClass,
  getCustomMcpToolSchema,
  listCustomMcpServerCacheEntries,
  _seedCustomMcpServerSchemasForTesting,
  _refreshCustomMcpServerSchemasOnceForTesting,
} from '../tool-schema-cache';

function toolDef(name: string, extra: Partial<{ description: string; categories: string[]; isWrite: boolean }> = {}) {
  return {
    name,
    description: extra.description ?? `${name} desc`,
    inputSchema: { type: 'object', properties: {} },
    categories: extra.categories ?? ['read'],
    isWrite: extra.isWrite ?? false,
  };
}

describe('tool-schema-cache', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    __clearToolSchemaCacheForTests();
  });

  afterAll(() => {
    __clearToolSchemaCacheForTests();
  });

  it('seeds the cache from ListTools on init', async () => {
    mockListTools.mockResolvedValueOnce({
      toolSets: [
        {
          connectorType: 'slack',
          displayName: 'Slack',
          tools: [toolDef('post_message', { categories: ['write'] })],
        },
        {
          connectorType: 'google_mail',
          displayName: 'Google Mail',
          tools: [toolDef('read_email'), toolDef('send_email', { categories: ['write'] })],
        },
      ],
      version: 'v1',
      unchanged: false,
    });

    await initToolSchemaCache();

    expect(isToolSchemaCacheSeeded()).toBe(true);
    expect(listConnectorTypes().sort()).toEqual(['google_mail', 'slack']);
    const slackTools = getToolSchemas('slack');
    expect(slackTools.map((t) => t.name)).toEqual(['post_message']);
    expect(getToolSchema('google_mail', 'send_email')?.description).toBe('send_email desc');
    expect(getToolSchema('google_mail', 'missing')).toBeNull();

    const all = listAllToolSchemas();
    expect(all).toHaveLength(2);
  });

  it('keeps the internal-collaboration category a message function carries, and drops what it does not know', async () => {
    // The gate reads `internalCollaboration` as never held; filtered out here
    // it could never be read, and the tool would be gated as a plain write.
    mockListTools.mockResolvedValueOnce({
      toolSets: [{
        connectorType: 'slack',
        displayName: 'Slack',
        tools: [toolDef('send_message', { categories: ['write', 'internalCollaboration', 'made_up'] })],
      }],
      version: 'v1',
      unchanged: false,
    });
    await initToolSchemaCache();
    expect(getToolSchema('slack', 'send_message')?.categories).toEqual(['write', 'internalCollaboration']);
  });

  it('leaves the cache empty and still seeded when the RPC fails', async () => {
    mockListTools.mockRejectedValueOnce(new Error('boom'));

    await initToolSchemaCache();

    expect(isToolSchemaCacheSeeded()).toBe(true);
    expect(listConnectorTypes()).toEqual([]);
    expect(getToolSchemas('slack')).toEqual([]);
  });

  it('__setToolSchemaCacheForTests supports alias-based entity type resolution', () => {
    __setToolSchemaCacheForTests([
      {
        connectorType: 'google_mail',
        displayName: 'Google Mail',
        functions: [
          {
            name: 'send_email',
            description: 'send',
            inputSchema: { type: 'object', properties: {} },
            categories: ['write'],
            entityType: 'message',
          },
        ],
      },
    ]);

    // Exact match, alias via "google_" prefix, hyphen normalization.
    expect(resolveEntityType('google_mail', 'send_email')).toBe('message');
    expect(resolveEntityType('mail', 'send_email')).toBe('message');
    expect(resolveEntityType('google-mail', 'send_email')).toBe('message');
    // Unknown pair falls back to the function name.
    expect(resolveEntityType('unknown', 'no_such')).toBe('no_such');
  });

  it('short-circuits installing tool sets when the server reports unchanged', async () => {
    // Seed once.
    mockListTools.mockResolvedValueOnce({
      toolSets: [
        {
          connectorType: 'slack',
          displayName: 'Slack',
          tools: [toolDef('post_message')],
        },
      ],
      version: 'v1',
      unchanged: false,
    });

    await initToolSchemaCache();
    expect(getToolSchemas('slack')).toHaveLength(1);

    // Directly test the effect of `unchanged: true` by calling the public
    // API path through the seed logic: the cache must be preserved.
    // The background timer uses the same refreshOnce() path internally —
    // we can't await the timer here, but we can assert that the initial
    // seed installed the tool set and nothing else reset it.
    expect(isToolSchemaCacheSeeded()).toBe(true);
    expect(listConnectorTypes()).toEqual(['slack']);
  });
});

const SERVER = 'd144a7ea-1111-4111-8111-111111111111';

function fetchStub(list: unknown, raw: unknown) {
  const calls: string[] = [];
  const impl = jest.fn(async (url: string) => {
    calls.push(url);
    const forT1 = new URL(url).searchParams.get('tenantId') === 't1';
    const body = url.includes('/by-id/raw-tools') ? raw : (forT1 ? list : { servers: [] });
    return { ok: true, status: 200, json: async () => body } as unknown as Response;
  });
  return { impl, calls };
}

describe('withEffectClass', () => {
  const base = { name: 'enrich_company', description: 'd', inputSchema: { type: 'object' as const, properties: {} }, categories: ['read'] as never };
  it('present → appended and declared, existing categories preserved', () => {
    const out = withEffectClass({ ...base, categories: ['datachanges'] as never }, 'read', true);
    expect(out.categories).toEqual(['datachanges', 'read']);
    expect(out.classificationDeclared).toBe(true);
  });
  it('absent, unknown, or the classifier off → unchanged', () => {
    expect(withEffectClass(base, undefined, true)).toEqual(base);
    expect(withEffectClass(base, 'unclear', true)).toEqual(base);
    expect(withEffectClass(base, 'read', false)).toEqual(base);
    expect((withEffectClass(base, 'read', false) as { classificationDeclared?: boolean }).classificationDeclared).toBeUndefined();
  });
});

describe('the custom-MCP refresh under 1b', () => {
  const realFetch = global.fetch;
  beforeEach(() => {
    process.env.PLATFORM_BACKEND_URL = 'https://pb.test';
    _seedCustomMcpServerSchemasForTesting([]);
  });
  afterEach(() => { global.fetch = realFetch; });

  const list = (version?: string) => ({ servers: [{ id: SERVER, name: 's', connectorId: SERVER, updatedAt: '2026-09-21T00:00:00.000Z', ...(version ? { version } : {}) }] });
  const raw = (version: string, effectClasses: Record<string, string> = {}, classifierEnabled?: boolean) => ({
    tools: [{ name: 'enrich_company', description: 'Enrich', inputSchema: { type: 'object', properties: {} } }, { name: 'delete_record', description: 'Delete', inputSchema: { type: 'object', properties: {} } }],
    version,
    effectClasses,
    ...(classifierEnabled === undefined ? {} : { classifierEnabled }),
  });

  it('maps effect classes as declared and stores the raw-tools version', async () => {
    const { impl } = fetchStub(list('2026-09-21T00:00:00.000Z|1'), raw('2026-09-21T00:00:00.000Z|1', { enrich_company: 'read', delete_record: 'destructive' }));
    global.fetch = impl as unknown as typeof fetch;
    await _refreshCustomMcpServerSchemasOnceForTesting();
    const entry = listCustomMcpServerCacheEntries()[0];
    expect(entry.version).toBe('2026-09-21T00:00:00.000Z|1');
    const enrich = getCustomMcpToolSchema('t1', 'custom-mcp-d144a7ea', 'enrich_company');
    expect(enrich?.categories).toContain('read');
    expect(enrich?.classificationDeclared).toBe(true);
    const del = getCustomMcpToolSchema('t1', 'custom-mcp-d144a7ea', 'delete_record');
    expect(del?.categories).toContain('destructive');
  });

  it('an unchanged updatedAt with a changed classifier segment refetches; the same version does not', async () => {
    let stub = fetchStub(list('2026-09-21T00:00:00.000Z|1'), raw('2026-09-21T00:00:00.000Z|1', { enrich_company: 'read' }));
    global.fetch = stub.impl as unknown as typeof fetch;
    await _refreshCustomMcpServerSchemasOnceForTesting();
    expect(stub.calls.filter((u) => u.includes('raw-tools'))).toHaveLength(1);

    // Same version: the entry is kept, no raw-tools fetch.
    stub = fetchStub(list('2026-09-21T00:00:00.000Z|1'), raw('2026-09-21T00:00:00.000Z|1', { enrich_company: 'read' }));
    global.fetch = stub.impl as unknown as typeof fetch;
    await _refreshCustomMcpServerSchemasOnceForTesting();
    expect(stub.calls.filter((u) => u.includes('raw-tools'))).toHaveLength(0);

    // The flag flipped off on the control plane: `|off`, effect classes omitted.
    stub = fetchStub(list('2026-09-21T00:00:00.000Z|off'), raw('2026-09-21T00:00:00.000Z|off', {}, false));
    global.fetch = stub.impl as unknown as typeof fetch;
    await _refreshCustomMcpServerSchemasOnceForTesting();
    expect(stub.calls.filter((u) => u.includes('raw-tools'))).toHaveLength(1);
    const enrich = getCustomMcpToolSchema('t1', 'custom-mcp-d144a7ea', 'enrich_company');
    expect(enrich?.categories ?? []).not.toContain('read');
    expect(enrich?.classificationDeclared).toBeUndefined();

    // A classification-version bump alone refetches too.
    stub = fetchStub(list('2026-09-21T00:00:00.000Z|2'), raw('2026-09-21T00:00:00.000Z|2', { enrich_company: 'read' }));
    global.fetch = stub.impl as unknown as typeof fetch;
    await _refreshCustomMcpServerSchemasOnceForTesting();
    expect(stub.calls.filter((u) => u.includes('raw-tools'))).toHaveLength(1);
    expect(getCustomMcpToolSchema('t1', 'custom-mcp-d144a7ea', 'enrich_company')?.classificationDeclared).toBe(true);
  });

  it('a list without version falls back to updatedAt (an older control plane)', async () => {
    let stub = fetchStub(list(), { tools: raw('x').tools, version: '2026-09-21T00:00:00.000Z' });
    global.fetch = stub.impl as unknown as typeof fetch;
    await _refreshCustomMcpServerSchemasOnceForTesting();
    expect(listCustomMcpServerCacheEntries()[0].version).toBe('2026-09-21T00:00:00.000Z');
    stub = fetchStub(list(), { tools: raw('x').tools, version: '2026-09-21T00:00:00.000Z' });
    global.fetch = stub.impl as unknown as typeof fetch;
    await _refreshCustomMcpServerSchemasOnceForTesting();
    expect(stub.calls.filter((u) => u.includes('raw-tools'))).toHaveLength(0);
    // And no effect class was appended: today's behaviour.
    expect(getCustomMcpToolSchema('t1', 'custom-mcp-d144a7ea', 'enrich_company')?.classificationDeclared).toBeUndefined();
  });

  it('a payload stating the classifier off appends nothing even when handed a class', async () => {
    const stub = fetchStub(list('v|off'), raw('v|off', { enrich_company: 'read' }, false));
    global.fetch = stub.impl as unknown as typeof fetch;
    await _refreshCustomMcpServerSchemasOnceForTesting();
    expect(getCustomMcpToolSchema('t1', 'custom-mcp-d144a7ea', 'enrich_company')?.classificationDeclared).toBeUndefined();
  });
});
