/**
 * WebFetchRouter under the team binding — the unbound shape and its inverse.
 *
 * The workspace has Exa and Tavily connected. A team bound to nothing must
 * reach neither ACCOUNT: its chain is the platform backends, and when those
 * include Exa and Tavily (the platform's own pay-as-you-go keys) the clients
 * are handed a scope naming no workspace connector. A team bound to Exa
 * reaches Exa and not Tavily, and the Exa client resolves its key under a
 * credential scope naming the bound connector. router.test.ts covers chain
 * order and escalation with every vendor bound; this covers the binding.
 */

const mockGetAllVendorFlags = jest.fn();
const mockIsVendorEnabled = jest.fn();
const mockAcquireInflightSlot = jest.fn();
const mockConsumeToken = jest.fn();
const mockPoolQuery = jest.fn();
const mockGetTenantConnectedWebVendors = jest.fn();
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };

jest.mock('../global-flags', () => ({
  getAllVendorFlags: (...a: unknown[]) => mockGetAllVendorFlags(...a),
  isVendorEnabled: (...a: unknown[]) => mockIsVendorEnabled(...a),
  isVendorExcludedForTenant: jest.fn().mockResolvedValue(false),
  isEffortRoutingEnabled: jest.fn().mockResolvedValue(false),
}));
jest.mock('../concurrency-limits', () => {
  class VendorPoolBusy extends Error {
    constructor(public vendor: string, public _retryAfterMs: number) { super(`vendor_pool_busy:${vendor}`); }
  }
  return { acquireInflightSlot: (...a: unknown[]) => mockAcquireInflightSlot(...a), VendorPoolBusy };
});
jest.mock('../token-bucket', () => ({ consumeToken: (...a: unknown[]) => mockConsumeToken(...a) }));
jest.mock('../../../infrastructure/database', () => ({
  getPool: () => ({ query: (...a: unknown[]) => mockPoolQuery(...a) }),
}));
jest.mock('../../../infrastructure/logging', () => ({ logger: mockLogger }));
jest.mock('../../../agent-lifecycle/resolve-runtime-agent-id', () => ({
  resolveRuntimeAgentId: async (_t: string, id: string) => id,
}));
jest.mock('../web-tool-secrets', () => {
  const actual = jest.requireActual('../web-tool-secrets');
  return {
    ...actual,
    getTenantConnectedWebVendors: (...a: unknown[]) => mockGetTenantConnectedWebVendors(...a),
  };
});

import { VendorHealthCache, WebFetchRouter } from '../router';
import type { CredentialScope } from '../credential-scope';
import type { InternalWebFetchAdvancedResult, WebFetchAdvancedRequest } from '../types';

function fakeResult(vendor: InternalWebFetchAdvancedResult['vendor']): InternalWebFetchAdvancedResult {
  return { content: 'ok', finalUrl: 'https://x', sessionId: undefined, vendor, costMicros: 0, jsRendered: false };
}

/** Clients that record the credential scope the router handed them — the
 *  value the real clients pass to getWebToolCredential. */
function buildClients() {
  const seen: Record<string, CredentialScope | undefined> = {};
  const client = (vendor: InternalWebFetchAdvancedResult['vendor']) => ({
    vendor,
    fetch: jest.fn(async (req: { credentialScope?: CredentialScope }) => {
      seen[vendor] = req.credentialScope;
      return fakeResult(vendor);
    }),
    research: jest.fn().mockResolvedValue({ answer: 'a', sources: [], vendor, costMicros: 0 }),
    supportsSessions: () => false,
  } as any);
  return {
    seen,
    webclaw: client('webclaw'),
    firecrawl: client('firecrawl'),
    perplexity: client('perplexity'),
    anchor: client('anchor'),
    browserbase: client('browserbase'),
    tavily: client('tavily'),
    exa: client('exa'),
    openai: client('openai'),
    google: client('google'),
    steel: client('steel'),
  };
}

function routerOf(c: ReturnType<typeof buildClients>): WebFetchRouter {
  return new WebFetchRouter(
    c.webclaw, c.firecrawl, c.perplexity, c.anchor, c.browserbase, c.tavily, c.exa, c.openai, c.google,
    { fetch: jest.fn() } as any, { webSearch: jest.fn(), xSearch: jest.fn() } as any, c.steel, new VendorHealthCache(),
  );
}

const ctx = { tenantId: 't1', agentId: 'team-1', traceId: 'trace' };
const ALL_ON = {
  webclaw: true, firecrawl: true, perplexity: true, anchor: true, browserbase: true, tavily: true, exa: true,
  openai: true, google: true, browser_use: false, xai: true, steel: false, browserbase_x402: false,
};

function instruction(integrations: unknown): void {
  mockPoolQuery.mockResolvedValue({ rows: [{ integrations }] });
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAllVendorFlags.mockResolvedValue(ALL_ON);
  mockIsVendorEnabled.mockResolvedValue(true);
  mockAcquireInflightSlot.mockResolvedValue({ requestId: 'rid', release: jest.fn().mockResolvedValue(undefined) });
  mockConsumeToken.mockResolvedValue({ ok: true });
  mockGetTenantConnectedWebVendors.mockResolvedValue(new Set(['exa', 'tavily']));
});

describe('a team bound to nothing', () => {
  beforeEach(() => instruction([]));

  it('fetch: the platform backend serves, and when it fails the next platform rung is Exa on OUR key, never the workspace account', async () => {
    const c = buildClients();
    c.perplexity.fetch.mockRejectedValue(new Error('perplexity timeout'));
    const out = await routerOf(c).fetch({ url: 'https://x' } as WebFetchAdvancedRequest, ctx);
    expect(out.vendor).toBe('exa');
    expect(c.seen.exa?.connectorIds?.size).toBe(0);
    expect(c.tavily.fetch).not.toHaveBeenCalled();
  });

  it('fetch: with the platform Exa and Tavily switched off, a failed platform backend does not reach the workspace accounts', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...ALL_ON, exa: false, tavily: false });
    const c = buildClients();
    c.perplexity.fetch.mockRejectedValue(new Error('perplexity timeout'));
    await expect(routerOf(c).fetch({ url: 'https://x' } as WebFetchAdvancedRequest, ctx)).rejects.toThrow('perplexity timeout');
    expect(c.exa.fetch).not.toHaveBeenCalled();
    expect(c.tavily.fetch).not.toHaveBeenCalled();
  });

  it('research: the platform backend serves, never the workspace accounts', async () => {
    const c = buildClients();
    const out = await routerOf(c).research({ question: 'q' } as never, ctx);
    expect(out.vendor).toBe('perplexity');
    expect(c.exa.research).not.toHaveBeenCalled();
    expect(c.tavily.research).not.toHaveBeenCalled();
  });

  it('names the excluded vendors once per call, on a countable event', async () => {
    const c = buildClients();
    await routerOf(c).fetch({ url: 'https://x' } as WebFetchAdvancedRequest, ctx);
    expect(mockLogger.info).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'web_vendor_excluded_by_binding', tool: 'web_fetch_advanced', excluded: expect.arrayContaining(['exa', 'tavily']) }),
      expect.any(String),
    );
  });
});

describe('a team bound to one of the two', () => {
  beforeEach(() => instruction([{ id: 'c-exa-1', type: 'exa' }]));

  it('fetch reads through the bound account FIRST, with the platform backend healthy and untouched', async () => {
    const c = buildClients();
    const out = await routerOf(c).fetch({ url: 'https://x' } as WebFetchAdvancedRequest, ctx);
    expect(out.vendor).toBe('exa');
    expect(c.perplexity.fetch).not.toHaveBeenCalled();
    expect(c.tavily.fetch).not.toHaveBeenCalled();
  });

  it('research reads through the bound account first as well', async () => {
    const c = buildClients();
    const out = await routerOf(c).research({ question: 'q' } as never, ctx);
    expect(out.vendor).toBe('exa');
    expect(c.perplexity.research).not.toHaveBeenCalled();
  });

  it('the bound vendor is handed a scope naming the bound connector only', async () => {
    const c = buildClients();
    await routerOf(c).fetch({ url: 'https://x' } as WebFetchAdvancedRequest, ctx);
    expect([...(c.seen.exa?.connectorIds ?? [])]).toEqual(['c-exa-1']);
  });

  it('when the bound account fails, the platform backend is the safety net, and is handed no scope', async () => {
    const c = buildClients();
    c.exa.fetch.mockRejectedValue(new Error('exa down'));
    const out = await routerOf(c).fetch({ url: 'https://x' } as WebFetchAdvancedRequest, ctx);
    expect(out.vendor).toBe('perplexity');
    expect(c.seen.perplexity).toBeUndefined();
  });
});

describe('the attempt budget', () => {
  it('two bound accounts that both fail still reach the platform safety net (three attempts)', async () => {
    instruction([{ id: 'c-exa-1', type: 'exa' }, { id: 'c-tv-1', type: 'tavily' }]);
    const c = buildClients();
    c.exa.fetch.mockRejectedValue(new Error('exa down'));
    c.tavily.fetch.mockRejectedValue(new Error('tavily down'));
    const out = await routerOf(c).fetch({ url: 'https://x' } as WebFetchAdvancedRequest, ctx);
    expect(out.vendor).toBe('perplexity');
    expect(c.exa.fetch).toHaveBeenCalledTimes(1);
    expect(c.tavily.fetch).toHaveBeenCalledTimes(1);
  });

  it('one bound attempt leaves exactly one platform attempt: a failing safety net is not retried on a third platform vendor', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...ALL_ON, steel: true });
    instruction([{ id: 'c-exa-1', type: 'exa' }]);
    const c = buildClients();
    c.exa.fetch.mockRejectedValue(new Error('exa down'));
    c.perplexity.fetch.mockRejectedValue(new Error('perplexity down'));
    await expect(routerOf(c).fetch({ url: 'https://x' } as WebFetchAdvancedRequest, ctx)).rejects.toThrow('perplexity down');
    expect(c.steel.fetch).not.toHaveBeenCalled();
  });

  it('a team bound to nothing keeps two platform attempts, and no third', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...ALL_ON, steel: true });
    instruction([]);
    const c = buildClients();
    c.perplexity.fetch.mockRejectedValue(new Error('perplexity down'));
    const out = await routerOf(c).fetch({ url: 'https://x' } as WebFetchAdvancedRequest, ctx);
    expect(out.vendor).toBe('exa');
    expect(c.steel.fetch).not.toHaveBeenCalled();
    c.exa.fetch.mockRejectedValue(new Error('exa down'));
    await expect(routerOf(c).fetch({ url: 'https://x' } as WebFetchAdvancedRequest, ctx)).rejects.toThrow('exa down');
    expect(c.tavily.fetch).not.toHaveBeenCalled();
    expect(c.steel.fetch).not.toHaveBeenCalled();
  });
});

describe('a platform-funded vendor the workspace connected but the team is not bound to', () => {
  it('is dispatched with NO workspace connector, so the platform key serves', async () => {
    mockGetTenantConnectedWebVendors.mockResolvedValue(new Set(['steel']));
    mockGetAllVendorFlags.mockResolvedValue({ ...ALL_ON, perplexity: false, exa: false, tavily: false, steel: true });
    instruction([]);
    const c = buildClients();
    const out = await routerOf(c).fetch({ url: 'https://x' } as WebFetchAdvancedRequest, ctx);
    expect(out.vendor).toBe('steel');
    expect(c.seen.steel?.connectorIds?.size).toBe(0);
  });
});

describe('no active instruction', () => {
  it('is no opinion: the connected vendors serve, as the workspace\'s own tier, with any connector of the type', async () => {
    mockPoolQuery.mockResolvedValue({ rows: [] });
    const c = buildClients();
    const out = await routerOf(c).fetch({ url: 'https://x' } as WebFetchAdvancedRequest, ctx);
    expect(out.vendor).toBe('exa');
    expect(c.seen.exa?.connectorIds).toBeNull();
  });
});
