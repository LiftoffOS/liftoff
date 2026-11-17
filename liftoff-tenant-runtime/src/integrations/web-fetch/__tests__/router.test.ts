/**
 * WebFetchRouter unit tests.
 *
 * Covers escalation, vendor health TTL, session-pinning, and flag-driven
 * filtering. DB calls (`web_sessions` lookup for sessionId routing) and the
 * concurrency-ceiling check are mocked.
 */

const mockGetAllVendorFlags = jest.fn();
const mockIsVendorEnabled = jest.fn();
const mockIsVendorExcludedForTenant = jest.fn();
const mockIsEffortRoutingEnabled = jest.fn();
const mockAcquireInflightSlot = jest.fn();
const mockConsumeToken = jest.fn();
const mockPoolQuery = jest.fn();

jest.mock('../global-flags', () => ({
  getAllVendorFlags: (...a: unknown[]) => mockGetAllVendorFlags(...a),
  isVendorEnabled:   (...a: unknown[]) => mockIsVendorEnabled(...a),
  isVendorExcludedForTenant: (...a: unknown[]) => mockIsVendorExcludedForTenant(...a),
  isEffortRoutingEnabled: (...a: unknown[]) => mockIsEffortRoutingEnabled(...a),
}));
jest.mock('../concurrency-limits', () => {
  class VendorPoolBusy extends Error {
    constructor(public vendor: string, public retryAfterMs: number) { super(`vendor_pool_busy:${vendor}`); }
  }
  return {
    acquireInflightSlot: (...a: unknown[]) => mockAcquireInflightSlot(...a),
    VendorPoolBusy,
  };
});
jest.mock('../token-bucket', () => ({
  consumeToken: (...a: unknown[]) => mockConsumeToken(...a),
}));
jest.mock('../../../infrastructure/database', () => ({
  getPool: () => ({ query: (...a: unknown[]) => mockPoolQuery(...a) }),
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// Escalation tests assume every BYOK vendor is connected for the tenant so
// the chain assembled by `vendorAvailable()` can fall through to exa/anchor/
// tavily/webclaw/firecrawl. The real `getTenantConnectedWebVendors` would hit
// connector-service; stub it to return the full set.
jest.mock('../web-tool-secrets', () => {
  const actual = jest.requireActual('../web-tool-secrets');
  return {
    ...actual,
    getTenantConnectedWebVendors: jest.fn().mockResolvedValue(
      new Set(['firecrawl', 'anchor_browser', 'browserbase', 'tavily', 'exa', 'webclaw']),
    ),
  };
});

// The chain tests assume the team is BOUND to every vendor the workspace
// connected, so the scope is the connected set — and the team's own accounts are tried BEFORE the platform tier (vendor-order.ts), so
// under this fixture Exa leads the no-JS chain and Anchor the JS chain, with
// Perplexity the safety net. The binding read itself is covered by
// vendor-scope.test.ts and router-vendor-scope.test.ts.
jest.mock('../vendor-scope', () => ({
  usableWebVendors: jest.fn(async (tenantId: string, _agentId: string | undefined, pre?: Set<string>) => {
    const { getTenantConnectedWebVendors } = jest.requireMock('../web-tool-secrets');
    const vendors = pre ?? await getTenantConnectedWebVendors(tenantId);
    return { vendors, connectorIds: new Map(), excluded: [], basis: 'bound' };
  }),
  logExcludedVendors: jest.fn(),
}));

import { VendorHealthCache, WebFetchRouter } from '../router';
import { SteelError } from '../steel-client';
import { BrowserbaseX402Error } from '../browserbase-x402-client';
import type {
  WebFetchAdvancedRequest, InternalWebFetchAdvancedResult,
} from '../types';

function fakeResult(vendor: 'webclaw' | 'firecrawl' | 'perplexity' | 'anchor' | 'browserbase' | 'tavily' | 'exa' | 'openai' | 'google'): InternalWebFetchAdvancedResult {
  return {
    content: 'ok',
    finalUrl: 'https://example.com',
    sessionId: undefined,
    vendor,
    costMicros: 0,
    jsRendered: false,
  };
}

function buildClients(opts: {
  webclawFetch?: jest.Mock; firecrawlFetch?: jest.Mock; perplexityFetch?: jest.Mock; anchorFetch?: jest.Mock; browserbaseFetch?: jest.Mock;
  perplexityResearch?: jest.Mock; perplexityPeopleSearch?: jest.Mock; perplexityFinanceSearch?: jest.Mock; perplexityDeepResearch?: jest.Mock;
  webclawResearch?: jest.Mock; firecrawlResearch?: jest.Mock;
  tavilyFetch?: jest.Mock; tavilyResearch?: jest.Mock;
  exaFetch?: jest.Mock; exaResearch?: jest.Mock;
  openaiDeepResearch?: jest.Mock; googleDeepResearch?: jest.Mock;
} = {}) {
  return {
    webclaw: { vendor: 'webclaw', fetch: opts.webclawFetch ?? jest.fn().mockResolvedValue(fakeResult('webclaw')), research: opts.webclawResearch ?? jest.fn().mockResolvedValue({ answer: 'wc', sources: [], vendor: 'webclaw', costMicros: 0 }), supportsSessions: () => false } as any,
    firecrawl: { vendor: 'firecrawl', fetch: opts.firecrawlFetch ?? jest.fn().mockResolvedValue(fakeResult('firecrawl')), research: opts.firecrawlResearch ?? jest.fn().mockResolvedValue({ answer: 'fc', sources: [], vendor: 'firecrawl', costMicros: 0 }), supportsSessions: () => false } as any,
    perplexity: {
      vendor: 'perplexity',
      fetch: opts.perplexityFetch ?? jest.fn().mockResolvedValue(fakeResult('perplexity')),
      research: opts.perplexityResearch ?? jest.fn().mockResolvedValue({ answer: 'pp', sources: [], vendor: 'perplexity', costMicros: 5000 }),
      peopleSearch: opts.perplexityPeopleSearch ?? jest.fn().mockResolvedValue({ results: [], vendor: 'perplexity', costMicros: 5000 }),
      financeSearch: opts.perplexityFinanceSearch ?? jest.fn().mockResolvedValue({ results: [], vendor: 'perplexity', costMicros: 5000 }),
      deepResearch: opts.perplexityDeepResearch ?? jest.fn().mockResolvedValue({ report: 'r', sources: [], vendor: 'perplexity', costMicros: 150000, usage: { prompt_tokens: 0, completion_tokens: 0, citation_tokens: 0, reasoning_tokens: 0, num_search_queries: 0 }, durationMs: 100 }),
      supportsSessions: () => false,
    } as any,
    anchor: { vendor: 'anchor', fetch: opts.anchorFetch ?? jest.fn().mockResolvedValue(fakeResult('anchor')), supportsSessions: () => true } as any,
    browserbase: { vendor: 'browserbase', fetch: opts.browserbaseFetch ?? jest.fn().mockResolvedValue(fakeResult('browserbase')), supportsSessions: () => true } as any,
    tavily: {
      vendor: 'tavily',
      fetch: opts.tavilyFetch ?? jest.fn().mockResolvedValue(fakeResult('tavily')),
      research: opts.tavilyResearch ?? jest.fn().mockResolvedValue({ answer: 'tv', sources: [], vendor: 'tavily', costMicros: 0 }),
      supportsSessions: () => false,
    } as any,
    exa: {
      vendor: 'exa',
      fetch: opts.exaFetch ?? jest.fn().mockResolvedValue(fakeResult('exa')),
      research: opts.exaResearch ?? jest.fn().mockResolvedValue({ answer: 'ex', sources: [], vendor: 'exa', costMicros: 0 }),
      supportsSessions: () => false,
    } as any,
    openai: {
      vendor: 'openai',
      fetch: jest.fn().mockRejectedValue(new Error('openai fetch disabled')),
      deepResearch: opts.openaiDeepResearch ?? jest.fn().mockResolvedValue({
        report: 'r', sources: [], vendor: 'openai', costMicros: 2_000_000,
        deepResearchId: 'oai-1', usage: { prompt_tokens: 0, completion_tokens: 0, citation_tokens: 0, reasoning_tokens: 0, num_search_queries: 0 },
        durationMs: 100,
      }),
      supportsSessions: () => false,
    } as any,
    google: {
      vendor: 'google',
      fetch: jest.fn().mockRejectedValue(new Error('google fetch disabled')),
      deepResearch: opts.googleDeepResearch ?? jest.fn().mockResolvedValue({
        report: 'r', sources: [], vendor: 'google', costMicros: 2_000_000,
        deepResearchId: 'g-1', usage: { prompt_tokens: 0, completion_tokens: 0, citation_tokens: 0, reasoning_tokens: 0, num_search_queries: 0 },
        durationMs: 100,
      }),
      supportsSessions: () => false,
    } as any,
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAllVendorFlags.mockResolvedValue({ webclaw: true, firecrawl: true, perplexity: true, anchor: true, browserbase: true, tavily: true, exa: true, openai: true, google: true });
  mockIsVendorEnabled.mockResolvedValue(true);
  mockIsVendorExcludedForTenant.mockResolvedValue(false);
  mockIsEffortRoutingEnabled.mockResolvedValue(false);   // legacy by default for these tests
  mockAcquireInflightSlot.mockResolvedValue({ requestId: 'rid', release: jest.fn().mockResolvedValue(undefined) });
  mockConsumeToken.mockResolvedValue({ ok: true });
  mockPoolQuery.mockResolvedValue({ rows: [] });
});

const ctx = { tenantId: 't1', agentId: 'a1', traceId: 'trace1' };

describe('WebFetchRouter — fetch escalation', () => {
  it('tries the team\'s own cheapest text vendor first for non-JS stateless requests, not the platform', async () => {
    const c = buildClients();
    const router = new WebFetchRouter(c.webclaw, c.firecrawl, c.perplexity, c.anchor, c.browserbase, c.tavily, c.exa, c.openai, c.google, new VendorHealthCache());
    const out = await router.fetch({ url: 'https://x' } as WebFetchAdvancedRequest, ctx);
    expect(out.vendor).toBe('exa');
    expect(c.perplexity.fetch).not.toHaveBeenCalled();
    expect(c.firecrawl.fetch).not.toHaveBeenCalled();
    expect(c.webclaw.fetch).not.toHaveBeenCalled();
    expect(c.anchor.fetch).not.toHaveBeenCalled();
  });

  it('falls through to tavily when exa health-fails (non-JS)', async () => {
    const c = buildClients({
      exaFetch: jest.fn().mockRejectedValue(new Error('exa down')),
    });
    const router = new WebFetchRouter(c.webclaw, c.firecrawl, c.perplexity, c.anchor, c.browserbase, c.tavily, c.exa, c.openai, c.google, new VendorHealthCache());
    const out = await router.fetch({ url: 'https://x' }, ctx);
    expect(out.vendor).toBe('tavily');
  });

  it('two failed bound attempts reach the platform safety net and no third bound vendor', async () => {
    const c = buildClients({
      exaFetch:    jest.fn().mockRejectedValue(new Error('exa down')),
      tavilyFetch: jest.fn().mockRejectedValue(new Error('tavily down')),
    });
    const router = new WebFetchRouter(c.webclaw, c.firecrawl, c.perplexity, c.anchor, c.browserbase, c.tavily, c.exa, c.openai, c.google, new VendorHealthCache());
    const out = await router.fetch({ url: 'https://x' }, ctx);
    expect(out.vendor).toBe('perplexity');
    expect(c.firecrawl.fetch).not.toHaveBeenCalled();
    expect(c.webclaw.fetch).not.toHaveBeenCalled();
    expect(c.anchor.fetch).not.toHaveBeenCalled();
    expect(c.browserbase.fetch).not.toHaveBeenCalled();
  });

  it('a failed safety net after two bound failures is the end of the chain', async () => {
    const c = buildClients({
      exaFetch:        jest.fn().mockRejectedValue(new Error('exa down')),
      tavilyFetch:     jest.fn().mockRejectedValue(new Error('tavily down')),
      perplexityFetch: jest.fn().mockRejectedValue(new Error('perplexity down')),
    });
    const router = new WebFetchRouter(c.webclaw, c.firecrawl, c.perplexity, c.anchor, c.browserbase, c.tavily, c.exa, c.openai, c.google, new VendorHealthCache());
    await expect(router.fetch({ url: 'https://x' }, ctx)).rejects.toThrow('perplexity down');
    expect(c.firecrawl.fetch).not.toHaveBeenCalled();
    expect(c.anchor.fetch).not.toHaveBeenCalled();
  });

  it('tries the team\'s own preferred browser first when JS rendering is needed', async () => {
    const c = buildClients();
    const router = new WebFetchRouter(c.webclaw, c.firecrawl, c.perplexity, c.anchor, c.browserbase, c.tavily, c.exa, c.openai, c.google, new VendorHealthCache());
    const out = await router.fetch({ url: 'https://x', waitFor: { type: 'networkidle' } }, ctx);
    expect(out.vendor).toBe('anchor');
    expect(c.perplexity.fetch).not.toHaveBeenCalled();
  });

  it('falls through to browserbase when anchor health-fails (needsJs)', async () => {
    const c = buildClients({
      anchorFetch: jest.fn().mockRejectedValue(new Error('anchor down')),
    });
    const router = new WebFetchRouter(c.webclaw, c.firecrawl, c.perplexity, c.anchor, c.browserbase, c.tavily, c.exa, c.openai, c.google, new VendorHealthCache());
    const out = await router.fetch({ url: 'https://x', waitFor: { type: 'networkidle' } }, ctx);
    expect(out.vendor).toBe('browserbase');
  });

  it('removes a disabled vendor from the chain', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ webclaw: false, firecrawl: false, perplexity: false, anchor: true, browserbase: true, tavily: false, exa: false, openai: false, google: false });
    const c = buildClients();
    const router = new WebFetchRouter(c.webclaw, c.firecrawl, c.perplexity, c.anchor, c.browserbase, c.tavily, c.exa, c.openai, c.google, new VendorHealthCache());
    const out = await router.fetch({ url: 'https://x' }, ctx);
    expect(out.vendor).toBe('anchor');
    expect(c.webclaw.fetch).not.toHaveBeenCalled();
    expect(c.firecrawl.fetch).not.toHaveBeenCalled();
    expect(c.perplexity.fetch).not.toHaveBeenCalled();
  });

  it('throws "no web fetch backends available" when all flags are off', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ webclaw: false, firecrawl: false, perplexity: false, anchor: false, browserbase: false, tavily: false, exa: false, openai: false, google: false });
    const c = buildClients();
    const router = new WebFetchRouter(c.webclaw, c.firecrawl, c.perplexity, c.anchor, c.browserbase, c.tavily, c.exa, c.openai, c.google, new VendorHealthCache());
    await expect(router.fetch({ url: 'https://x' }, ctx)).rejects.toThrow(/no web fetch backends available/);
  });

  it('pins to the recorded vendor when session_id resolves to an existing row', async () => {
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ vendor: 'anchor' }] });
    const c = buildClients();
    const router = new WebFetchRouter(c.webclaw, c.firecrawl, c.perplexity, c.anchor, c.browserbase, c.tavily, c.exa, c.openai, c.google, new VendorHealthCache());
    const out = await router.fetch({ url: 'https://x', sessionId: 'sess-1' }, ctx);
    expect(out.vendor).toBe('anchor');
    expect(c.webclaw.fetch).not.toHaveBeenCalled();
    expect(c.firecrawl.fetch).not.toHaveBeenCalled();
    expect(c.perplexity.fetch).not.toHaveBeenCalled();
    expect(c.browserbase.fetch).not.toHaveBeenCalled();
  });
});

describe('WebFetchRouter — research / search / deep-research', () => {
  it('research falls through perplexity → exa → tavily → webclaw → firecrawl', async () => {
    const c = buildClients({
      perplexityResearch: jest.fn().mockRejectedValue(new Error('perplexity down')),
    });
    const router = new WebFetchRouter(c.webclaw, c.firecrawl, c.perplexity, c.anchor, c.browserbase, c.tavily, c.exa, c.openai, c.google, new VendorHealthCache());
    const out = await router.research({ question: 'q' }, ctx);
    // Chain head is perplexity → exa. With perplexity rejecting, exa
    // (second in chain) succeeds via default mock. attempts > 2 break means
    // tavily / webclaw / firecrawl are never reached on a single-failure path.
    expect(out.vendor).toBe('exa');
  });

  it('peopleSearch succeeds when perplexity enabled', async () => {
    const c = buildClients();
    const router = new WebFetchRouter(c.webclaw, c.firecrawl, c.perplexity, c.anchor, c.browserbase, c.tavily, c.exa, c.openai, c.google, new VendorHealthCache());
    const out = await router.peopleSearch({ query: 'alice' }, ctx);
    expect(out.vendor).toBe('perplexity');
    expect(c.perplexity.peopleSearch).toHaveBeenCalled();
  });

  it('peopleSearch throws "backend unavailable" when perplexity disabled', async () => {
    mockIsVendorEnabled.mockResolvedValue(false);
    const c = buildClients();
    const router = new WebFetchRouter(c.webclaw, c.firecrawl, c.perplexity, c.anchor, c.browserbase, c.tavily, c.exa, c.openai, c.google, new VendorHealthCache());
    await expect(router.peopleSearch({ query: 'alice' }, ctx)).rejects.toThrow(/backend unavailable/);
  });

  it('financeSearch succeeds when perplexity enabled', async () => {
    const c = buildClients();
    const router = new WebFetchRouter(c.webclaw, c.firecrawl, c.perplexity, c.anchor, c.browserbase, c.tavily, c.exa, c.openai, c.google, new VendorHealthCache());
    const out = await router.financeSearch({ query: 'AAPL' }, ctx);
    expect(out.vendor).toBe('perplexity');
    expect(c.perplexity.financeSearch).toHaveBeenCalled();
  });

  it('financeSearch throws "backend unavailable" when perplexity disabled', async () => {
    mockIsVendorEnabled.mockResolvedValue(false);
    const c = buildClients();
    const router = new WebFetchRouter(c.webclaw, c.firecrawl, c.perplexity, c.anchor, c.browserbase, c.tavily, c.exa, c.openai, c.google, new VendorHealthCache());
    await expect(router.financeSearch({ query: 'AAPL' }, ctx)).rejects.toThrow(/backend unavailable/);
  });

  it('deepResearch succeeds when perplexity enabled', async () => {
    const c = buildClients();
    const router = new WebFetchRouter(c.webclaw, c.firecrawl, c.perplexity, c.anchor, c.browserbase, c.tavily, c.exa, c.openai, c.google, new VendorHealthCache());
    const out = await router.deepResearch({ question: 'q' }, ctx);
    expect(out.vendor).toBe('perplexity');
    expect(c.perplexity.deepResearch).toHaveBeenCalled();
  });

  it('deepResearch throws "backend unavailable" when perplexity disabled', async () => {
    mockIsVendorEnabled.mockResolvedValue(false);
    const c = buildClients();
    const router = new WebFetchRouter(c.webclaw, c.firecrawl, c.perplexity, c.anchor, c.browserbase, c.tavily, c.exa, c.openai, c.google, new VendorHealthCache());
    await expect(router.deepResearch({ question: 'q' }, ctx)).rejects.toThrow(/backend unavailable/);
  });
});

// The bridged basic search picks its backend by the run's PROVIDER, not by
// cost tier: a Grok agent searches with Grok's search. Everyone else searches
// on Perplexity's Search API, and Perplexity stands behind xAI so a Grok agent
// is never left with no search at all when xAI is switched off.
const SEARCH_FLAGS = {
  webclaw: true, firecrawl: true, perplexity: true, anchor: true, browserbase: true, tavily: true,
  exa: true, openai: true, google: true, browser_use: true, xai: true, steel: true, browserbase_x402: true,
};

describe('WebFetchRouter — search (the bridged basic search)', () => {
  beforeEach(() => { mockGetAllVendorFlags.mockResolvedValue(SEARCH_FLAGS); });
  function withSearch() {
    const c = buildClients();
    c.perplexity.search = jest.fn().mockResolvedValue({ results: [{ url: 'https://p', title: 'P' }], vendor: 'perplexity', costMicros: 5000 });
    const xai = { xSearch: jest.fn(), webSearch: jest.fn().mockResolvedValue({ results: [{ url: 'https://x', title: 'X' }], summary: 'found', vendor: 'xai', costMicros: 5000 }) } as any;
    const browserUse = { vendor: 'browser_use', supportsSessions: () => true } as any;
    const rung = { search: jest.fn().mockResolvedValue({ results: [{ url: 'https://b', title: 'B' }], vendor: 'browserbase_x402', costMicros: 10_000, funding: 'x402_wallet' }), fetch: jest.fn() } as any;
    const router = new WebFetchRouter(c.webclaw, c.firecrawl, c.perplexity, c.anchor, c.browserbase, c.tavily, c.exa, c.openai, c.google, browserUse, xai, undefined, new VendorHealthCache(), rung);
    return { c, xai, rung, router };
  }

  it('searches on xAI for a Grok run', async () => {
    const { c, xai, router } = withSearch();
    const out = await router.search({ query: 'q' }, { ...ctx, provider: 'xai' });
    expect(out.vendor).toBe('xai');
    expect(xai.webSearch).toHaveBeenCalledWith({ query: 'q' });
    expect(c.perplexity.search).not.toHaveBeenCalled();
  });

  it('searches on Perplexity for an open-weights run, and never touches xAI', async () => {
    const { c, xai, router } = withSearch();
    for (const provider of ['glm', 'qwen', 'deepseek', 'kimi', 'minimax', 'google']) {
      const out = await router.search({ query: 'q' }, { ...ctx, provider });
      expect(out.vendor).toBe('perplexity');
    }
    expect(xai.webSearch).not.toHaveBeenCalled();
    expect(c.perplexity.search).toHaveBeenCalledTimes(6);
  });

  it('searches on Perplexity when the caller names no provider', async () => {
    const { router } = withSearch();
    const out = await router.search({ query: 'q' }, ctx);
    expect(out.vendor).toBe('perplexity');
  });

  it('falls back to Perplexity for a Grok run when xAI is switched off', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...SEARCH_FLAGS, xai: false });
    const { xai, router } = withSearch();
    const out = await router.search({ query: 'q' }, { ...ctx, provider: 'xai' });
    expect(out.vendor).toBe('perplexity');
    expect(xai.webSearch).not.toHaveBeenCalled();
  });

  it('throws "backend unavailable" when neither backend is on', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...SEARCH_FLAGS, xai: false, perplexity: false, browserbase_x402: false });
    const { router } = withSearch();
    await expect(router.search({ query: 'q' }, { ...ctx, provider: 'xai' })).rejects.toThrow(/web_search backend unavailable/);
  });

  // The x402 Browserbase gateway stands behind every platform search vendor.
  // runChain tries two vendors per call, so it serves only when the vendors
  // ahead of it are off or unhealthy — a fallback, never the first choice.
  it('never reaches the x402 rung while a platform search vendor answers', async () => {
    const { rung, router } = withSearch();
    expect((await router.search({ query: 'q' }, ctx)).vendor).toBe('perplexity');
    expect((await router.search({ query: 'q' }, { ...ctx, provider: 'xai' })).vendor).toBe('xai');
    expect(rung.search).not.toHaveBeenCalled();
  });

  it('serves search from the x402 rung when every platform search vendor is off', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...SEARCH_FLAGS, xai: false, perplexity: false });
    const { rung, router } = withSearch();
    const out = await router.search({ query: 'q' }, { ...ctx, provider: 'xai' });
    expect(out.vendor).toBe('browserbase_x402');
    expect(out.funding).toBe('x402_wallet');
    expect(rung.search).toHaveBeenCalledWith({ query: 'q' }, expect.objectContaining({ tenantId: 't1' }));
  });

  it('falls through to the x402 rung when Perplexity fails mid-call', async () => {
    const { c, rung, router } = withSearch();
    c.perplexity.search = jest.fn().mockRejectedValue(new Error('perplexity down'));
    const out = await router.search({ query: 'q' }, ctx);
    expect(out.vendor).toBe('browserbase_x402');
  });

  it('is switched off by its own flag like any vendor', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...SEARCH_FLAGS, perplexity: false, browserbase_x402: false });
    const { rung, router } = withSearch();
    await expect(router.search({ query: 'q' }, ctx)).rejects.toThrow(/web_search backend unavailable/);
    expect(rung.search).not.toHaveBeenCalled();
  });
});

// The rung in the fetch chain: last in both orderings, behind the platform
// browser, and its 402 (the wallet could not pay) parks it for the health
// window instead of being retried on every call.
describe('WebFetchRouter — the x402 Browserbase rung (fetch)', () => {
  const ALL_ON = {
    webclaw: true, firecrawl: true, perplexity: true, anchor: true, browserbase: true, tavily: true,
    exa: true, openai: true, google: true, browser_use: true, xai: true, steel: true, browserbase_x402: true,
  };
  // The BYOK vendors are all "connected" in this file's fixture; switching
  // them off leaves the platform-funded chain a workspace with no keys sees.
  const PLATFORM_ONLY = { ...ALL_ON, webclaw: false, firecrawl: false, anchor: false, browserbase: false, tavily: false, exa: false };
  function withRung(rungFetch?: jest.Mock) {
    const c = buildClients();
    const rung = { fetch: rungFetch ?? jest.fn().mockResolvedValue({ ...fakeResult('perplexity'), vendor: 'browserbase_x402', costMicros: 10_000, funding: 'x402_wallet' }) } as any;
    const browserUse = { vendor: 'browser_use', supportsSessions: () => true, fetch: jest.fn().mockResolvedValue({ ...fakeResult('perplexity'), vendor: 'browser_use' }) } as any;
    const steel = { vendor: 'steel', supportsSessions: () => true, fetch: jest.fn().mockResolvedValue({ ...fakeResult('perplexity'), vendor: 'steel' }) } as any;
    const xai = { xSearch: jest.fn(), webSearch: jest.fn() } as any;
    const health = new VendorHealthCache();
    const router = new WebFetchRouter(c.webclaw, c.firecrawl, c.perplexity, c.anchor, c.browserbase, c.tavily, c.exa, c.openai, c.google, browserUse, xai, steel, health, rung);
    return { c, rung, steel, browserUse, health, router };
  }

  it('is the last rung in both orderings', () => {
    const { health } = withRung();
    const { orderFetchChain } = jest.requireActual('../vendor-order') as typeof import('../vendor-order');
    const unbound = { vendors: new Set(), connectorIds: new Map(), excluded: [], basis: 'unbound' as const };
    const build = (needsJs: boolean) => orderFetchChain(needsJs, ALL_ON, unbound, health);
    for (const needsJs of [false, true]) {
      const chain: string[] = build(needsJs);
      expect(chain[chain.length - 1]).toBe('browserbase_x402');
      expect(chain.indexOf('steel')).toBeLessThan(chain.indexOf('browserbase_x402'));
      expect(chain.indexOf('browser_use')).toBeLessThan(chain.indexOf('browserbase_x402'));
      expect(chain.indexOf('perplexity')).toBeLessThan(chain.indexOf('browserbase_x402'));
    }
  });

  it('is never reached while the platform browser answers', async () => {
    // A workspace with no BYOK vendor: perplexity, steel, browser_use and the
    // rung are what is available, and two attempts never get past steel.
    mockGetAllVendorFlags.mockResolvedValue({ ...PLATFORM_ONLY, perplexity: false });
    const { rung, steel, router } = withRung();
    const out = await router.fetch({ url: 'https://example.com' }, ctx);
    expect(out.vendor).toBe('steel');
    expect(steel.fetch).toHaveBeenCalled();
    expect(rung.fetch).not.toHaveBeenCalled();
  });

  it('serves the page when the platform browser is out', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...PLATFORM_ONLY, perplexity: false, browser_use: false });
    const { rung, steel, router } = withRung();
    steel.fetch.mockRejectedValue(new SteelError('steel down', 503));
    const out = await router.fetch({ url: 'https://example.com' }, ctx);
    expect(out.vendor).toBe('browserbase_x402');
    expect(out.funding).toBe('x402_wallet');
    expect(rung.fetch).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.com', tenantId: 't1', traceId: 'trace1' }));
  });

  it('parks the rung for the health window when the wallet cannot pay (402)', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...PLATFORM_ONLY, perplexity: false, steel: false, browser_use: false });
    const rungFetch = jest.fn().mockRejectedValue(new BrowserbaseX402Error('x402 payment refused', 402));
    const { health, router } = withRung(rungFetch);
    await expect(router.fetch({ url: 'https://example.com' }, ctx)).rejects.toThrow(/payment refused/);
    expect(health.isHealthy('browserbase_x402')).toBe(false);
    // The next call does not pay a second failed attempt.
    await expect(router.fetch({ url: 'https://example.com' }, ctx)).rejects.toThrow(/no web fetch backends available/);
    expect(rungFetch).toHaveBeenCalledTimes(1);
  });

  it('does not park the rung on a caller-side 4xx', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...PLATFORM_ONLY, perplexity: false, steel: false, browser_use: false });
    const rungFetch = jest.fn().mockRejectedValue(new BrowserbaseX402Error('bad url', 400));
    const { health, router } = withRung(rungFetch);
    await expect(router.fetch({ url: 'https://example.com' }, ctx)).rejects.toThrow(/bad url/);
    expect(health.isHealthy('browserbase_x402')).toBe(true);
  });
});

// The pay-per-use web rung on the platform's Locus key: a page read ahead of
// the platform browsers, the ONE platform extract backend, and a basic search
// behind Perplexity. Its 402 (the platform's Locus balance is empty) parks it
// for the health window like the x402 rung's.
describe('WebFetchRouter — the Locus web rung', () => {
  const { LocusWebError } = jest.requireActual('../locus-web-client') as typeof import('../locus-web-client');
  const ALL_ON = {
    webclaw: true, firecrawl: true, perplexity: true, anchor: true, browserbase: true, tavily: true,
    exa: true, openai: true, google: true, browser_use: true, xai: true, steel: true, browserbase_x402: true, locus_web: true,
  };
  // What a workspace with no keys of its own sees: the platform tier alone.
  const PLATFORM_ONLY = { ...ALL_ON, webclaw: false, firecrawl: false, anchor: false, browserbase: false, tavily: false, exa: false };
  function withLocus(locus?: Partial<Record<'fetch' | 'search' | 'extract', jest.Mock>>) {
    const c = buildClients();
    c.perplexity.search = jest.fn().mockResolvedValue({ results: [{ url: 'https://p', title: 'P' }], vendor: 'perplexity', costMicros: 5000 });
    const rung = {
      fetch: locus?.fetch ?? jest.fn().mockResolvedValue({ ...fakeResult('perplexity'), vendor: 'locus_web', costMicros: 3_000, jsRendered: true, funding: 'platform' }),
      search: locus?.search ?? jest.fn().mockResolvedValue({ results: [{ url: 'https://l', title: 'L' }], vendor: 'locus_web', costMicros: 4_660, funding: 'platform' }),
      extract: locus?.extract ?? jest.fn().mockResolvedValue({ data: { title: 'extracted' }, finalUrl: 'https://example.com', vendor: 'locus_web', costMicros: 7_000, jsRendered: true, funding: 'platform' }),
    } as any;
    const x402 = { fetch: jest.fn(), search: jest.fn() } as any;
    const browserUse = { vendor: 'browser_use', supportsSessions: () => true, fetch: jest.fn().mockResolvedValue({ ...fakeResult('perplexity'), vendor: 'browser_use' }) } as any;
    const steel = { vendor: 'steel', supportsSessions: () => true, fetch: jest.fn().mockResolvedValue({ ...fakeResult('perplexity'), vendor: 'steel' }) } as any;
    const xai = { xSearch: jest.fn(), webSearch: jest.fn() } as any;
    const health = new VendorHealthCache();
    const router = new WebFetchRouter(c.webclaw, c.firecrawl, c.perplexity, c.anchor, c.browserbase, c.tavily, c.exa, c.openai, c.google, browserUse, xai, steel, health, x402, rung);
    return { c, rung, x402, steel, browserUse, health, router };
  }

  it('reads a page ahead of the platform browsers when the cheaper platform reads are out', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...PLATFORM_ONLY, perplexity: false });
    const { rung, steel, x402, router } = withLocus();
    const out = await router.fetch({ url: 'https://example.com' }, ctx);
    expect(out.vendor).toBe('locus_web');
    expect(out.funding).toBe('platform');
    expect(rung.fetch).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.com', tenantId: 't1', traceId: 'trace1' }));
    expect(steel.fetch).not.toHaveBeenCalled();
    expect(x402.fetch).not.toHaveBeenCalled();
  });

  it('leads the platform tier for a page that needs JavaScript, with the platform browser behind it', async () => {
    mockGetAllVendorFlags.mockResolvedValue(PLATFORM_ONLY);
    const { c, rung, steel, router } = withLocus();
    const out = await router.fetch({ url: 'https://example.com', waitFor: 1000 }, ctx);
    expect(out.vendor).toBe('locus_web');
    expect(c.perplexity.fetch).not.toHaveBeenCalled();
    rung.fetch.mockRejectedValue(new LocusWebError('locus_web web_page_scrape: ENDPOINT_DISABLED', 400));
    expect((await router.fetch({ url: 'https://example.com', waitFor: 1000 }, ctx)).vendor).toBe('steel');
    expect(steel.fetch).toHaveBeenCalledTimes(1);
    expect(c.perplexity.fetch).not.toHaveBeenCalled();
  });

  it('is never reached for a page read while Perplexity answers', async () => {
    mockGetAllVendorFlags.mockResolvedValue(PLATFORM_ONLY);
    const { rung, router } = withLocus();
    expect((await router.fetch({ url: 'https://example.com' }, ctx)).vendor).toBe('perplexity');
    expect(rung.fetch).not.toHaveBeenCalled();
  });

  it('is the one platform extract backend: a workspace with no extract keys of its own still extracts', async () => {
    mockGetAllVendorFlags.mockResolvedValue(PLATFORM_ONLY);
    const { rung, router } = withLocus();
    const out = await router.extract({ url: 'https://example.com', schema: {} } as never, ctx);
    expect(out.vendor).toBe('locus_web');
    expect(out.data).toEqual({ title: 'extracted' });
    expect(out.funding).toBe('platform');
    expect(rung.extract).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.com', tenantId: 't1', traceId: 'trace1' }));
  });

  it('extracts behind a team\'s own bound accounts, not ahead of them', async () => {
    mockGetAllVendorFlags.mockResolvedValue(ALL_ON);
    const { c, rung, router } = withLocus();
    c.firecrawl.extract = jest.fn().mockResolvedValue({ data: { title: 'own key' }, finalUrl: 'https://example.com', vendor: 'firecrawl', costMicros: 0, jsRendered: false });
    const out = await router.extract({ url: 'https://example.com', schema: {} } as never, ctx);
    expect(out.vendor).toBe('firecrawl');
    expect(rung.extract).not.toHaveBeenCalled();
  });

  it('searches behind Perplexity and ahead of the x402 rung', async () => {
    mockGetAllVendorFlags.mockResolvedValue(PLATFORM_ONLY);
    const { c, rung, x402, router } = withLocus();
    expect((await router.search({ query: 'q' }, ctx)).vendor).toBe('perplexity');
    expect(rung.search).not.toHaveBeenCalled();
    c.perplexity.search = jest.fn().mockRejectedValue(new Error('perplexity down'));
    const out = await router.search({ query: 'q' }, ctx);
    expect(out.vendor).toBe('locus_web');
    expect(out.funding).toBe('platform');
    expect(rung.search).toHaveBeenCalledWith({ query: 'q' }, expect.objectContaining({ tenantId: 't1' }));
    expect(x402.search).not.toHaveBeenCalled();
  });

  it('parks the rung for the health window when the platform balance cannot pay (402)', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...PLATFORM_ONLY, perplexity: false, steel: false, browser_use: false, browserbase_x402: false });
    const fetch = jest.fn().mockRejectedValue(new LocusWebError('locus_web web_page_scrape: HTTP 402 payment required: insufficient credits', 402));
    const { health, router } = withLocus({ fetch });
    await expect(router.fetch({ url: 'https://example.com' }, ctx)).rejects.toThrow(/payment required/);
    expect(health.isHealthy('locus_web')).toBe(false);
    await expect(router.fetch({ url: 'https://example.com' }, ctx)).rejects.toThrow(/no web fetch backends available/);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('does not park the rung on a caller-side 4xx', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...PLATFORM_ONLY, perplexity: false, steel: false, browser_use: false, browserbase_x402: false });
    const fetch = jest.fn().mockRejectedValue(new LocusWebError('locus_web web_page_scrape: bad url', 400));
    const { health, router } = withLocus({ fetch });
    await expect(router.fetch({ url: 'https://example.com' }, ctx)).rejects.toThrow(/bad url/);
    expect(health.isHealthy('locus_web')).toBe(true);
  });

  it('is switched off by its own flag like any vendor', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...PLATFORM_ONLY, locus_web: false });
    const { rung, router } = withLocus();
    await expect(router.extract({ url: 'https://example.com', schema: {} } as never, ctx)).rejects.toThrow();
    expect(rung.extract).not.toHaveBeenCalled();
  });
});

// The Exa overflow: Exa's own x402 API on the platform's Locus key, directly
// behind the platform's Exa in the tier. Taken when that key is rate-limited —
// a 429 from Exa, or the runtime's own admission cap for it — and a refusal
// on rate spends none of the attempt budget, because the vendor did no work.
describe('WebFetchRouter — the Exa overflow rung', () => {
  const { ExaError } = jest.requireActual('../exa-client') as typeof import('../exa-client');
  const ALL_ON = {
    webclaw: true, firecrawl: true, perplexity: true, anchor: true, browserbase: true, tavily: true,
    exa: true, openai: true, google: true, browser_use: true, xai: true, steel: true, browserbase_x402: true, locus_web: true, locus_exa: true,
  };
  // The BYOK vendors are "connected" in this file's fixture but the team is
  // bound to none of them for these cases: the platform tier alone.
  const PLATFORM_ONLY = { ...ALL_ON, webclaw: false, firecrawl: false, anchor: false, browserbase: false };
  function withOverflow() {
    const c = buildClients();
    const overflow = {
      fetch: jest.fn().mockResolvedValue({ ...fakeResult('perplexity'), vendor: 'locus_exa', costMicros: 1_000, funding: 'platform' }),
      research: jest.fn().mockResolvedValue({ answer: 'joined', sources: [{ url: 'https://a', title: 'A' }], vendor: 'locus_exa', costMicros: 6_000, funding: 'platform' }),
    } as any;
    const x402 = { fetch: jest.fn(), search: jest.fn() } as any;
    const locusWeb = { fetch: jest.fn(), search: jest.fn(), extract: jest.fn() } as any;
    const browserUse = { vendor: 'browser_use', supportsSessions: () => true, fetch: jest.fn() } as any;
    const steel = { vendor: 'steel', supportsSessions: () => true, fetch: jest.fn() } as any;
    const xai = { xSearch: jest.fn(), webSearch: jest.fn() } as any;
    const health = new VendorHealthCache();
    const router = new WebFetchRouter(c.webclaw, c.firecrawl, c.perplexity, c.anchor, c.browserbase, c.tavily, c.exa, c.openai, c.google, browserUse, xai, steel, health, x402, locusWeb, overflow);
    return { c, overflow, locusWeb, health, router };
  }

  beforeEach(() => {
    // These cases bind the team to nothing, so the platform tier serves.
    (jest.requireMock('../web-tool-secrets') as { getTenantConnectedWebVendors: jest.Mock }).getTenantConnectedWebVendors.mockResolvedValue(new Set());
  });
  afterEach(() => {
    (jest.requireMock('../web-tool-secrets') as { getTenantConnectedWebVendors: jest.Mock }).getTenantConnectedWebVendors.mockResolvedValue(
      new Set(['firecrawl', 'anchor_browser', 'browserbase', 'tavily', 'exa', 'webclaw']),
    );
  });

  it('is never reached while the platform Exa answers', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...PLATFORM_ONLY, perplexity: false });
    const { c, overflow, router } = withOverflow();
    const out = await router.fetch({ url: 'https://example.com' }, ctx);
    expect(out.vendor).toBe('exa');
    expect(c.exa.fetch).toHaveBeenCalledTimes(1);
    expect(overflow.fetch).not.toHaveBeenCalled();
  });

  it('serves the page when the platform Exa is rate-limited, and the 429 spends no budget', async () => {
    mockGetAllVendorFlags.mockResolvedValue(PLATFORM_ONLY);
    const { c, overflow, health, router } = withOverflow();
    c.perplexity.fetch.mockRejectedValue(new Error('perplexity down'));
    c.exa.fetch.mockRejectedValue(new ExaError('rate limited', 429));
    const out = await router.fetch({ url: 'https://example.com' }, ctx);
    expect(out.vendor).toBe('locus_exa');
    expect(out.funding).toBe('platform');
    expect(overflow.fetch).toHaveBeenCalledWith(expect.objectContaining({ url: 'https://example.com', tenantId: 't1', traceId: 'trace1' }));
    // A refusal on rate is not a failure of the vendor's health.
    expect(health.isHealthy('exa')).toBe(true);
  });

  it('a platform Exa at its own admission cap overflows too, at no cost to the budget', async () => {
    mockGetAllVendorFlags.mockResolvedValue(PLATFORM_ONLY);
    const { c, overflow, router } = withOverflow();
    c.perplexity.fetch.mockRejectedValue(new Error('perplexity down'));
    const { VendorPoolBusy } = jest.requireMock('../concurrency-limits') as { VendorPoolBusy: new (v: string, ms: number) => Error };
    mockAcquireInflightSlot.mockImplementation(async (vendor: string) => {
      if (vendor === 'exa') throw new VendorPoolBusy('exa', 500);
      return { requestId: 'rid', release: jest.fn().mockResolvedValue(undefined) };
    });
    const out = await router.fetch({ url: 'https://example.com' }, ctx);
    expect(out.vendor).toBe('locus_exa');
    expect(c.exa.fetch).not.toHaveBeenCalled();
    mockAcquireInflightSlot.mockResolvedValue({ requestId: 'rid', release: jest.fn().mockResolvedValue(undefined) });
  });

  it('a platform Exa that FAILED (not a refusal on rate) still spends the budget, so the overflow is the second and last attempt', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...PLATFORM_ONLY, perplexity: false });
    const { c, overflow, router } = withOverflow();
    c.exa.fetch.mockRejectedValue(new ExaError('exa down', 503));
    overflow.fetch.mockRejectedValue(new Error('overflow down'));
    await expect(router.fetch({ url: 'https://example.com' }, ctx)).rejects.toThrow('overflow down');
    expect(c.tavily.fetch).not.toHaveBeenCalled();
  });

  it('researches through the overflow when the platform Exa is rate-limited, behind Perplexity', async () => {
    mockGetAllVendorFlags.mockResolvedValue(PLATFORM_ONLY);
    const { c, overflow, router } = withOverflow();
    c.perplexity.research = jest.fn().mockRejectedValue(new Error('perplexity down'));
    c.exa.research = jest.fn().mockRejectedValue(new ExaError('rate limited', 429));
    const out = await router.research({ question: 'q' } as never, ctx);
    expect(out.vendor).toBe('locus_exa');
    expect(out.funding).toBe('platform');
    expect(overflow.research).toHaveBeenCalledWith(expect.objectContaining({ question: 'q', tenantId: 't1' }));
    expect(c.tavily.research).not.toHaveBeenCalled();
  });

  it('is switched off by its own flag like any vendor', async () => {
    mockGetAllVendorFlags.mockResolvedValue({ ...PLATFORM_ONLY, perplexity: false, locus_exa: false });
    const { c, overflow, router } = withOverflow();
    c.exa.fetch.mockRejectedValue(new ExaError('rate limited', 429));
    const out = await router.fetch({ url: 'https://example.com' }, ctx);
    expect(out.vendor).toBe('tavily');
    expect(overflow.fetch).not.toHaveBeenCalled();
  });
});

describe('VendorHealthCache', () => {
  it('marks a vendor unhealthy for the TTL', () => {
    const cache = new VendorHealthCache();
    expect(cache.isHealthy('anchor')).toBe(true);
    cache.markFailed('anchor');
    expect(cache.isHealthy('anchor')).toBe(false);
  });
});

// A page that cannot be retrieved is reported as that, and only when it is
// that. The router keeps every vendor failure of the call beside `lastErr`;
// the fetch-shaped calls classify exhaustion from all of them, and only a
// chain where EVERY vendor reported an origin miss leaves as PageUnretrievable.
describe('WebFetchRouter — a missing page is an answer, not a failure', () => {
  const { PageUnretrievable } = jest.requireActual('../router') as typeof import('../router');
  const { ExaError } = jest.requireActual('../exa-client') as typeof import('../exa-client');
  const { PerplexityError } = jest.requireActual('../perplexity-client') as typeof import('../perplexity-client');
  const { FirecrawlError } = jest.requireActual('../firecrawl-client') as typeof import('../firecrawl-client');

  it('origin misses on every attempt leave as PageUnretrievable carrying each vendor and reason', async () => {
    const { TavilyError } = jest.requireActual('../tavily-client') as typeof import('../tavily-client');
    const c = buildClients({
      exaFetch:        jest.fn().mockRejectedValue(new ExaError('Empty content from Exa /contents (likely antibot block or unsupported URL)', 200)),
      tavilyFetch:     jest.fn().mockRejectedValue(new TavilyError('Empty content from Tavily /extract (likely antibot block)', 200)),
      perplexityFetch: jest.fn().mockRejectedValue(new PerplexityError('Empty content from Perplexity fetch_url (likely antibot block)', 200)),
    });
    const router = new WebFetchRouter(c.webclaw, c.firecrawl, c.perplexity, c.anchor, c.browserbase, c.tavily, c.exa, c.openai, c.google, new VendorHealthCache());
    let thrown: unknown;
    try {
      await router.fetch({ url: 'https://example.com/blog?token=abc' }, ctx);
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(PageUnretrievable);
    const miss = thrown as InstanceType<typeof PageUnretrievable>;
    expect(miss.url).toBe('https://example.com/blog?token=abc');
    // The team's two accounts, then the platform safety net: three attempts.
    expect(miss.failures.map((f) => f.vendor)).toEqual(['exa', 'tavily', 'perplexity']);
    expect(miss.failures[0].reason).toMatch(/Empty content from Exa/);
    expect(miss.failures[2].reason).toMatch(/Empty content from Perplexity/);
    // The message never carries the raw address.
    expect(miss.message).toContain('token=%5BREDACTED%5D');
  });

  it('a miss then a 503 is the 503: mixed exhaustion keeps today\'s classification', async () => {
    const { TavilyError } = jest.requireActual('../tavily-client') as typeof import('../tavily-client');
    const c = buildClients({
      exaFetch:        jest.fn().mockRejectedValue(new ExaError('Empty content from Exa /contents (likely antibot block or unsupported URL)', 200)),
      tavilyFetch:     jest.fn().mockRejectedValue(new TavilyError('upstream unavailable', 503)),
      perplexityFetch: jest.fn().mockRejectedValue(new PerplexityError('Empty content from Perplexity fetch_url (likely antibot block)', 200)),
    });
    // Its own health cache: the 503 marks Tavily unhealthy for 60 s, which
    // must not leak into the next case through the module singleton that the
    // short constructor form leaves in place.
    const router = new WebFetchRouter(
      c.webclaw, c.firecrawl, c.perplexity, c.anchor, c.browserbase, c.tavily, c.exa, c.openai, c.google,
      { fetch: jest.fn() } as any, { xSearch: jest.fn(), webSearch: jest.fn() } as any, { fetch: jest.fn() } as any, new VendorHealthCache(),
    );
    let thrown: unknown;
    try {
      await router.fetch({ url: 'https://example.com' }, ctx);
    } catch (e) { thrown = e; }
    expect(thrown).not.toBeInstanceOf(PageUnretrievable);
    expect(thrown).toBeInstanceOf(PerplexityError);
  });

  it('bounds and redacts the reasons it carries out', async () => {
    const longReason = `Tavily /extract failed: 404 page not found at https://example.com/x?api_key=secret ${'x'.repeat(400)}`;
    const { TavilyError } = jest.requireActual('../tavily-client') as typeof import('../tavily-client');
    mockGetAllVendorFlags.mockResolvedValue({ webclaw: false, firecrawl: false, perplexity: false, anchor: false, browserbase: false, tavily: true, exa: true, openai: false, google: false });
    const c = buildClients({
      exaFetch:    jest.fn().mockRejectedValue(new ExaError('Empty content from Exa /contents', 200)),
      tavilyFetch: jest.fn().mockRejectedValue(new TavilyError(longReason, 200)),
    });
    const router = new WebFetchRouter(c.webclaw, c.firecrawl, c.perplexity, c.anchor, c.browserbase, c.tavily, c.exa, c.openai, c.google, new VendorHealthCache());
    let thrown: unknown;
    try {
      await router.fetch({ url: 'https://example.com/x' }, ctx);
    } catch (e) { thrown = e; }
    expect(thrown).toBeInstanceOf(PageUnretrievable);
    const tavily = (thrown as InstanceType<typeof PageUnretrievable>).failures.find((f) => f.vendor === 'tavily')!;
    expect(tavily.reason.length).toBeLessThanOrEqual(200);
    expect(tavily.reason).not.toContain('api_key=secret');
    expect(tavily.reason).toContain('api_key=%5BREDACTED%5D');
  });

  describe('extract validates its result centrally', () => {
    function extractRouter(firecrawlData: unknown, webclawData: unknown) {
      const c = buildClients();
      c.firecrawl.extract = jest.fn().mockResolvedValue({ data: firecrawlData, finalUrl: 'https://example.com', vendor: 'firecrawl', costMicros: 0, jsRendered: false });
      c.webclaw.extract = jest.fn().mockResolvedValue({ data: webclawData, finalUrl: 'https://example.com', vendor: 'webclaw', costMicros: 0, jsRendered: false });
      const router = new WebFetchRouter(c.webclaw, c.firecrawl, c.perplexity, c.anchor, c.browserbase, c.tavily, c.exa, c.openai, c.google, new VendorHealthCache());
      return { c, router };
    }

    it('moves down the chain when the first vendor hands back no data at all', async () => {
      const { c, router } = extractRouter(undefined, { title: 'found' });
      const out = await router.extract({ url: 'https://example.com', schema: {} } as never, ctx);
      expect(out.vendor).toBe('webclaw');
      expect(out.data).toEqual({ title: 'found' });
      expect(c.firecrawl.extract).toHaveBeenCalledTimes(1);
      expect(c.webclaw.extract).toHaveBeenCalledTimes(1);
    });

    it('two empty extractions leave as PageUnretrievable', async () => {
      const { router } = extractRouter(undefined, null);
      let thrown: unknown;
      try {
        await router.extract({ url: 'https://example.com', schema: {} } as never, ctx);
      } catch (e) { thrown = e; }
      expect(thrown).toBeInstanceOf(PageUnretrievable);
      expect((thrown as InstanceType<typeof PageUnretrievable>).failures.map((f) => f.vendor)).toEqual(['firecrawl', 'webclaw']);
    });

    it('an empty object is a valid extraction and is returned', async () => {
      const { c, router } = extractRouter({}, { title: 'never reached' });
      const out = await router.extract({ url: 'https://example.com', schema: {} } as never, ctx);
      expect(out.vendor).toBe('firecrawl');
      expect(out.data).toEqual({});
      expect(c.webclaw.extract).not.toHaveBeenCalled();
    });

    it('an empty extraction then a vendor 5xx is the 5xx', async () => {
      const c = buildClients();
      c.firecrawl.extract = jest.fn().mockResolvedValue({ data: undefined, finalUrl: 'https://example.com', vendor: 'firecrawl', costMicros: 0, jsRendered: false });
      c.webclaw.extract = jest.fn().mockRejectedValue(new FirecrawlError('boom', 500));
      const router = new WebFetchRouter(c.webclaw, c.firecrawl, c.perplexity, c.anchor, c.browserbase, c.tavily, c.exa, c.openai, c.google, new VendorHealthCache());
      await expect(router.extract({ url: 'https://example.com', schema: {} } as never, ctx)).rejects.toThrow('boom');
    });
  });
});
