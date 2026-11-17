/**
 * vendor-scope — a workspace's own web vendor serves only a team bound to it.
 *
 * A team with `integrations: []` must not fetch through the workspace's Exa
 * and Tavily accounts, which it would if the router asked only whether the
 * vendor was connected somewhere in the workspace. These pin the three answers the header of vendor-scope.ts
 * gives, and the id-space translation the read depends on.
 */

const mockPoolQuery = jest.fn();
const mockResolveRuntimeAgentId = jest.fn();
const mockGetTenantConnectedWebVendors = jest.fn();
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.mock('../../../infrastructure/database', () => ({
  getPool: () => ({ query: (...a: unknown[]) => mockPoolQuery(...a) }),
}));
jest.mock('../../../infrastructure/logging', () => ({ logger: mockLogger }));
jest.mock('../../../agent-lifecycle/resolve-runtime-agent-id', () => ({
  resolveRuntimeAgentId: (...a: unknown[]) => mockResolveRuntimeAgentId(...a),
}));
jest.mock('../web-tool-secrets', () => ({
  getTenantConnectedWebVendors: (...a: unknown[]) => mockGetTenantConnectedWebVendors(...a),
}));

import { boundWebVendorConnectors, usableWebVendors, logExcludedVendors } from '../vendor-scope';

const TENANT = 't-1';
const AGENT = 'a-runtime';

beforeEach(() => {
  jest.clearAllMocks();
  mockResolveRuntimeAgentId.mockImplementation(async (_t: string, id: string) => id);
  mockGetTenantConnectedWebVendors.mockResolvedValue(new Set(['exa', 'tavily']));
});

function instruction(integrations: unknown): void {
  mockPoolQuery.mockResolvedValue({ rows: [{ integrations }] });
}

describe('boundWebVendorConnectors', () => {
  it('maps each bound connector type to the connector ids it is bound through', async () => {
    instruction([
      { id: 'c-exa-1', type: 'exa' },
      { id: 'c-exa-2', type: 'exa' },
      { id: 'c-gmail', type: 'google_mail' },
    ]);
    const bound = await boundWebVendorConnectors(TENANT, AGENT);
    expect(bound).not.toBeNull();
    expect([...bound!.keys()].sort()).toEqual(['exa', 'google_mail']);
    expect([...bound!.get('exa')!]).toEqual(['c-exa-1', 'c-exa-2']);
  });

  it('a legacy entry whose id IS the type binds the type with no id constraint', async () => {
    instruction([{ id: 'tavily' }]);
    const bound = await boundWebVendorConnectors(TENANT, AGENT);
    expect(bound!.get('tavily')!.size).toBe(0);
  });

  it('is null when the agent has no active instruction', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    expect(await boundWebVendorConnectors(TENANT, AGENT)).toBeNull();
  });

  it('translates a control-plane id to the runtime id BEFORE reading the instruction', async () => {
    mockResolveRuntimeAgentId.mockResolvedValue('a-runtime-translated');
    instruction([{ id: 'c-exa-1', type: 'exa' }]);
    await boundWebVendorConnectors(TENANT, 'a-control-plane');
    expect(mockResolveRuntimeAgentId).toHaveBeenCalledWith(TENANT, 'a-control-plane', 'boundWebVendorConnectors');
    const [, params] = mockPoolQuery.mock.calls[0];
    expect(params).toEqual([TENANT, 'a-runtime-translated']);
  });
});

describe('usableWebVendors', () => {
  it('a team bound to nothing gets none of the workspace vendors, and they are named as excluded', async () => {
    instruction([]);
    const scope = await usableWebVendors(TENANT, AGENT);
    expect([...scope.vendors]).toEqual([]);
    expect(scope.excluded.sort()).toEqual(['exa', 'tavily']);
    expect(scope.basis).toBe('unbound');
  });

  it('a team bound to one vendor gets that vendor with its connector ids, the other excluded', async () => {
    instruction([{ id: 'c-exa-1', type: 'exa' }]);
    const scope = await usableWebVendors(TENANT, AGENT);
    expect([...scope.vendors]).toEqual(['exa']);
    expect([...scope.connectorIds.get('exa')!]).toEqual(['c-exa-1']);
    expect(scope.excluded).toEqual(['tavily']);
    expect(scope.basis).toBe('bound');
  });

  it('a binding the workspace has not connected contributes nothing', async () => {
    instruction([{ id: 'c-fc', type: 'firecrawl' }]);
    const scope = await usableWebVendors(TENANT, AGENT);
    expect([...scope.vendors]).toEqual([]);
    expect(scope.excluded.sort()).toEqual(['exa', 'tavily']);
  });

  it('no active instruction means no opinion: the connected set, nothing excluded', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const scope = await usableWebVendors(TENANT, AGENT);
    expect([...scope.vendors].sort()).toEqual(['exa', 'tavily']);
    expect(scope.excluded).toEqual([]);
    expect(scope.basis).toBe('no_instruction');
  });

  it('no agent at all is the workspace acting as itself: the connected set', async () => {
    const scope = await usableWebVendors(TENANT, undefined);
    expect([...scope.vendors].sort()).toEqual(['exa', 'tavily']);
    expect(mockPoolQuery).not.toHaveBeenCalled();
    expect(scope.basis).toBe('no_instruction');
  });

  it('an unreadable binding fails CLOSED: no workspace vendor, and a warning naming the event', async () => {
    mockPoolQuery.mockRejectedValue(new Error('connection reset'));
    const scope = await usableWebVendors(TENANT, AGENT);
    expect([...scope.vendors]).toEqual([]);
    expect(scope.excluded.sort()).toEqual(['exa', 'tavily']);
    expect(scope.basis).toBe('unreadable');
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'web_vendor_scope_unreadable', agentId: AGENT }),
      expect.any(String),
    );
  });

  it('uses a prefetched connected set instead of asking connector-service again', async () => {
    instruction([{ id: 'c-fc', type: 'firecrawl' }]);
    const scope = await usableWebVendors(TENANT, AGENT, new Set(['firecrawl']));
    expect([...scope.vendors]).toEqual(['firecrawl']);
    expect(mockGetTenantConnectedWebVendors).not.toHaveBeenCalled();
  });
});

describe('logExcludedVendors', () => {
  it('writes one countable line naming the excluded vendors, and nothing when none were', () => {
    logExcludedVendors(
      { vendors: new Set(), connectorIds: new Map(), excluded: ['exa'], basis: 'unbound' },
      { tenantId: TENANT, agentId: AGENT, toolName: 'web_fetch_advanced', traceId: 'tr' },
    );
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'web_vendor_excluded_by_binding', excluded: ['exa'], tool: 'web_fetch_advanced', basis: 'unbound' }),
      expect.any(String),
    );
    mockLogger.info.mockClear();
    logExcludedVendors(
      { vendors: new Set(['exa']), connectorIds: new Map(), excluded: [], basis: 'bound' },
      { tenantId: TENANT, agentId: AGENT, toolName: 'web_fetch_advanced' },
    );
    expect(mockLogger.info).not.toHaveBeenCalled();
  });
});
