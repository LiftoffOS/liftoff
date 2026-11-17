/**
 * A vendor out of budget overflows; a vendor nothing stands behind waits.
 *
 * Perplexity's Agent API admits ONE call per second on the platform key, and
 * Perplexity leads the platform chain for fetch, search and research — with
 * Exa, Locus and Tavily behind it. It is also the ONLY vendor serving
 * `web_finance_search` and `web_people_search`.
 *
 * Those two facts decide what the router must do, and the two answers are
 * opposite:
 *
 *   - a read that has Exa behind it must not queue behind Perplexity's own
 *     pacing. It overflows at once, and at no cost to the attempt budget,
 *     which is the rule the CONCURRENCY cap beside it already used.
 *   - a finance search has nothing to overflow to, so waiting for the token
 *     is what makes the call succeed. Refusing it instead is what put a
 *     one-second wait in front of the model as a tool failure.
 *
 * The consequence of getting the first one right is that the reads move off
 * Perplexity, which is what leaves its scarce second for the tool that cannot
 * go anywhere else.
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
  isVendorEnabled: (...a: unknown[]) => mockIsVendorEnabled(...a),
  isVendorExcludedForTenant: (...a: unknown[]) => mockIsVendorExcludedForTenant(...a),
  isEffortRoutingEnabled: (...a: unknown[]) => mockIsEffortRoutingEnabled(...a),
}));
jest.mock('../concurrency-limits', () => {
  class VendorPoolBusy extends Error {
    constructor(public vendor: string, public retryAfterMs: number) { super(`vendor_pool_busy:${vendor}`); }
  }
  return { acquireInflightSlot: (...a: unknown[]) => mockAcquireInflightSlot(...a), VendorPoolBusy };
});
jest.mock('../token-bucket', () => ({ consumeToken: (...a: unknown[]) => mockConsumeToken(...a) }));
jest.mock('../../../infrastructure/database', () => ({
  getPool: () => ({ query: (...a: unknown[]) => mockPoolQuery(...a) }),
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// No bound connector for anything: the workspace is on the platform tier, which
// is the tier whose ORDER puts Perplexity first and its overflow behind it.
jest.mock('../web-tool-secrets', () => ({
  ...jest.requireActual('../web-tool-secrets'),
  getTenantConnectedWebVendors: jest.fn().mockResolvedValue(new Set<string>()),
}));
jest.mock('../vendor-scope', () => ({
  usableWebVendors: jest.fn(async () => ({
    vendors: new Set<string>(), connectorIds: new Map(), excluded: [], basis: 'platform',
  })),
  logExcludedVendors: jest.fn(),
}));

import { VendorHealthCache, WebFetchRouter } from '../router';
import type { WebFetchAdvancedRequest } from '../types';

const ctx = { tenantId: 't1', agentId: 'a1', traceId: 'trace1' };
const ok = (vendor: string) => ({ content: 'ok', finalUrl: 'https://example.com', sessionId: undefined, vendor, costMicros: 0, jsRendered: false });

function clients() {
  const mk = (vendor: string) => ({
    vendor,
    fetch: jest.fn().mockResolvedValue(ok(vendor)),
    research: jest.fn().mockResolvedValue({ answer: vendor, sources: [], vendor, costMicros: 0 }),
    peopleSearch: jest.fn().mockResolvedValue({ results: [], vendor, costMicros: 0 }),
    financeSearch: jest.fn().mockResolvedValue({ results: [], vendor, costMicros: 0 }),
    deepResearch: jest.fn(),
    supportsSessions: () => false,
  });
  return {
    webclaw: mk('webclaw'), firecrawl: mk('firecrawl'), perplexity: mk('perplexity'),
    anchor: mk('anchor'), browserbase: mk('browserbase'), tavily: mk('tavily'),
    exa: mk('exa'), openai: mk('openai'), google: mk('google'),
  };
}
const build = (c: ReturnType<typeof clients>) => new WebFetchRouter(
  c.webclaw as never, c.firecrawl as never, c.perplexity as never, c.anchor as never,
  c.browserbase as never, c.tavily as never, c.exa as never, c.openai as never,
  c.google as never, new VendorHealthCache(),
);

/** The bucket is empty for `vendor` and has room for everyone else. */
function pacedOut(vendor: string) {
  mockConsumeToken.mockImplementation(async (_t: string, v: string) =>
    (v === vendor ? { ok: false, retryAfterMs: 1_000 } : { ok: true }));
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAllVendorFlags.mockResolvedValue({
    webclaw: true, firecrawl: true, perplexity: true, anchor: true,
    browserbase: true, tavily: true, exa: true, openai: true, google: true,
  });
  mockIsVendorEnabled.mockResolvedValue(true);
  mockIsVendorExcludedForTenant.mockResolvedValue(false);
  mockIsEffortRoutingEnabled.mockResolvedValue(false);
  mockAcquireInflightSlot.mockResolvedValue({ requestId: 'rid', release: jest.fn().mockResolvedValue(undefined) });
  mockConsumeToken.mockResolvedValue({ ok: true });
  mockPoolQuery.mockResolvedValue({ rows: [] });
});

describe('a read whose chain has another rung does not queue behind the pacing', () => {
  it('overflows to the next platform vendor instead of failing', async () => {
    pacedOut('perplexity');
    const c = clients();
    const out = await build(c).fetch({ url: 'https://x' } as WebFetchAdvancedRequest, ctx);
    expect(out.vendor).toBe('exa');
    expect(c.perplexity.fetch).not.toHaveBeenCalled();
  });

  it('asks the bucket not to wait, because waiting would be strictly worse', async () => {
    // The wait budget is the FOURTH argument. Zero here is the whole point:
    // the bucket must not hold a call while a different backend is free.
    pacedOut('perplexity');
    await build(clients()).fetch({ url: 'https://x' } as WebFetchAdvancedRequest, ctx);
    const perplexityCall = mockConsumeToken.mock.calls.find((a) => a[1] === 'perplexity');
    expect(perplexityCall?.[3]).toBe(0);
  });

  it('spends no attempt budget on the overflow, so the chain is not cut short', async () => {
    // The platform tier allows two attempts. If pacing consumed one, a single
    // paced vendor would leave only one real backend behind it.
    pacedOut('perplexity');
    const c = clients();
    c.exa.fetch.mockRejectedValue(new Error('exa down'));
    const out = await build(c).fetch({ url: 'https://x' } as WebFetchAdvancedRequest, ctx);
    // A THIRD rung was reached, which is only possible if the paced vendor
    // spent no attempt. Which rung depends on which clients this fixture
    // supplies, so the property is asserted rather than the name.
    expect(['perplexity', 'exa']).not.toContain(out.vendor);
    expect(c.exa.fetch).toHaveBeenCalled();
  });

  it('research overflows the same way', async () => {
    pacedOut('perplexity');
    const c = clients();
    const out = await build(c).research({ question: 'q' } as never, ctx);
    expect(out.vendor).toBe('exa');
  });
});

describe('a tool only one vendor serves waits for its token', () => {
  it('finance search lets the bucket wait, because there is nothing to overflow to', async () => {
    // `undefined` means "use your own budget" — the bucket then holds the call
    // for up to its wait budget, which at one token a second admits it.
    await build(clients()).financeSearch({ query: 'AAPL' } as never, ctx);
    const call = mockConsumeToken.mock.calls.find((a) => a[1] === 'perplexity');
    expect(call?.[3]).toBeUndefined();
  });

  it('people search likewise', async () => {
    await build(clients()).peopleSearch({ query: 'someone' } as never, ctx);
    const call = mockConsumeToken.mock.calls.find((a) => a[1] === 'perplexity');
    expect(call?.[3]).toBeUndefined();
  });

  it('and is refused transiently, never permanently, when the wait was not enough', async () => {
    // What reaches the caller after the bucket has already waited: a busy
    // signal carrying a retry-after, which the handler turns into a retryable
    // tool error. The alternative is the internal_error that killed the run.
    pacedOut('perplexity');
    await expect(build(clients()).financeSearch({ query: 'AAPL' } as never, ctx))
      .rejects.toMatchObject({ vendor: 'perplexity', retryAfterMs: 1_000 });
  });
});
