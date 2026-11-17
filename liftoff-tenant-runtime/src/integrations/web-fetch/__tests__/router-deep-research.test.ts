/**
 * Router deepResearch effort-routing + migration flag (D21) + admission-block fallback (D12).
 */

const mockGetAllVendorFlags = jest.fn();
const mockIsVendorEnabled = jest.fn();
const mockIsVendorExcludedForTenant = jest.fn();
const mockIsEffortRoutingEnabled = jest.fn();
const mockAcquireInflightSlot = jest.fn();
const mockConsumeToken = jest.fn();

jest.mock('../global-flags', () => ({
  getAllVendorFlags: (...a: unknown[]) => mockGetAllVendorFlags(...a),
  isVendorEnabled: (...a: unknown[]) => mockIsVendorEnabled(...a),
  isVendorExcludedForTenant: (...a: unknown[]) => mockIsVendorExcludedForTenant(...a),
  isEffortRoutingEnabled: (...a: unknown[]) => mockIsEffortRoutingEnabled(...a),
}));
jest.mock('../concurrency-limits', () => {
  class VendorPoolBusy extends Error {
    constructor(public vendor: string, public retryAfterMs: number) { super(`busy:${vendor}`); }
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
  getPool: () => ({ query: jest.fn().mockResolvedValue({ rows: [] }) }),
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// Deep-research chain falls through perplexity → exa → tavily, all of which
// are gated on connector-presence via `vendorAvailable()`. Stub the resolver
// so every BYOK vendor reads as connected.
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
// connected, so the scope is the connected set. The binding read itself is
// covered by vendor-scope.test.ts and router-vendor-scope.test.ts.
jest.mock('../vendor-scope', () => ({
  usableWebVendors: jest.fn(async (tenantId: string, _agentId: string | undefined, pre?: Set<string>) => {
    const { getTenantConnectedWebVendors } = jest.requireMock('../web-tool-secrets');
    const vendors = pre ?? await getTenantConnectedWebVendors(tenantId);
    return { vendors, connectorIds: new Map(), excluded: [], basis: 'bound' };
  }),
  logExcludedVendors: jest.fn(),
}));

import { WebFetchRouter, VendorHealthCache } from '../router';
import { VendorPoolBusy } from '../concurrency-limits';

const ctx = { tenantId: 't1', agentId: 'a1', traceId: 'trace1' };

function makeClient(vendor: string) {
  return {
    vendor,
    fetch: jest.fn().mockRejectedValue(new Error('fetch n/a')),
    deepResearch: jest.fn().mockResolvedValue({
      report: 'r', sources: [], vendor, costMicros: 1_000_000,
      deepResearchId: `${vendor}-1`,
      usage: { prompt_tokens: 0, completion_tokens: 0, citation_tokens: 0, reasoning_tokens: 0, num_search_queries: 0 },
      durationMs: 100,
    }),
    supportsSessions: () => false,
  } as any;
}

beforeEach(() => {
  jest.clearAllMocks();
  mockGetAllVendorFlags.mockResolvedValue({ webclaw: true, firecrawl: true, perplexity: true, anchor: true, browserbase: true, tavily: true, exa: true, openai: true, google: true });
  mockIsVendorEnabled.mockResolvedValue(true);
  mockIsVendorExcludedForTenant.mockResolvedValue(false);
  mockIsEffortRoutingEnabled.mockResolvedValue(true);   // default: routing on
  mockAcquireInflightSlot.mockResolvedValue({ requestId: 'rid', release: jest.fn().mockResolvedValue(undefined), refresh: jest.fn().mockResolvedValue({ refreshed: true }) });
  mockConsumeToken.mockResolvedValue({ ok: true });
});

function buildRouter(opts: {
  perplexityFails?: boolean;
  openaiFails?: boolean;
  googleFails?: boolean;
} = {}) {
  const perplexity = makeClient('perplexity');
  const openai = makeClient('openai');
  const google = makeClient('google');
  if (opts.perplexityFails) perplexity.deepResearch = jest.fn().mockRejectedValue(new Error('perplexity down'));
  if (opts.openaiFails) openai.deepResearch = jest.fn().mockRejectedValue(new Error('openai down'));
  if (opts.googleFails) google.deepResearch = jest.fn().mockRejectedValue(new Error('google down'));
  const stub = makeClient('stub');
  const router = new WebFetchRouter(stub, stub, perplexity, stub, stub, stub, stub, openai, google, new VendorHealthCache());
  return { router, perplexity, openai, google };
}

describe('Migration flag OFF — legacy single-vendor (Perplexity) behavior', () => {
  beforeEach(() => mockIsEffortRoutingEnabled.mockResolvedValue(false));

  it('effort=low → Perplexity with legacy effort=low', async () => {
    const { router, perplexity, openai, google } = buildRouter();
    const out = await router.deepResearch({ question: 'q', reasoningEffort: 'low' }, ctx);
    expect(out.vendor).toBe('perplexity');
    expect(perplexity.deepResearch).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: 'low' }),
      expect.anything(),
    );
    expect(openai.deepResearch).not.toHaveBeenCalled();
    expect(google.deepResearch).not.toHaveBeenCalled();
  });

  it('effort=medium → Perplexity with legacy effort=medium', async () => {
    const { router, perplexity } = buildRouter();
    await router.deepResearch({ question: 'q', reasoningEffort: 'medium' }, ctx);
    expect(perplexity.deepResearch).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: 'medium' }),
      expect.anything(),
    );
  });

  it('effort=high → Perplexity with legacy effort=high', async () => {
    const { router, perplexity } = buildRouter();
    await router.deepResearch({ question: 'q', reasoningEffort: 'high' }, ctx);
    expect(perplexity.deepResearch).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: 'high' }),
      expect.anything(),
    );
  });

  it('effort unset → defaults to low (handler default) but legacy still routes Perplexity', async () => {
    const { router, perplexity } = buildRouter();
    await router.deepResearch({ question: 'q' }, ctx);
    expect(perplexity.deepResearch).toHaveBeenCalled();
  });

  it('effort=highest (defensive — handler usually rejects) → coerced to legacy high', async () => {
    const { router, perplexity } = buildRouter();
    await router.deepResearch({ question: 'q', reasoningEffort: 'highest' }, ctx);
    expect(perplexity.deepResearch).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: 'high' }),
      expect.anything(),
    );
  });

  it('Perplexity disabled → throws backend unavailable', async () => {
    mockIsVendorEnabled.mockResolvedValue(false);
    const { router } = buildRouter();
    await expect(router.deepResearch({ question: 'q' }, ctx)).rejects.toThrow(/backend unavailable/);
  });
});

describe('Migration flag ON — effort-routed chain', () => {
  it('effort=low → Perplexity primary; D5: passed reasoningEffort=high', async () => {
    const { router, perplexity, openai, google } = buildRouter();
    const out = await router.deepResearch({ question: 'q', reasoningEffort: 'low' }, ctx);
    expect(out.vendor).toBe('perplexity');
    expect(perplexity.deepResearch).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: 'high' }),
      expect.anything(),
    );
    expect(openai.deepResearch).not.toHaveBeenCalled();
    expect(google.deepResearch).not.toHaveBeenCalled();
  });

  // Google Deep Research is hard-disabled (GOOGLE_DEEP_RESEARCH_UNAVAILABLE
  // in router.ts) until Google Cloud GAs the deep-research-preview/max
  // models. Schema-wise the agent-facing enum is narrowed to ['low','high']
  // so `medium` and `highest` shouldn't even reach the router; the tests
  // below verify the router's own belt-and-suspenders fallback in case
  // anything bypasses validation. When GCP ships the models, flip the
  // constant + extend the schema enum + extend handler validation in
  // lockstep, and these test names become correct again.

  it('effort=medium → Perplexity primary (Google disabled until GCP GAs Deep Research)', async () => {
    const { router, perplexity, google } = buildRouter();
    const out = await router.deepResearch({ question: 'q', reasoningEffort: 'medium' }, ctx);
    expect(out.vendor).toBe('perplexity');
    expect(google.deepResearch).not.toHaveBeenCalled();
    expect(perplexity.deepResearch).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: 'high' }),    // D5
      expect.anything(),
    );
  });

  it('effort=high → OpenAI primary', async () => {
    const { router, openai } = buildRouter();
    const out = await router.deepResearch({ question: 'q', reasoningEffort: 'high' }, ctx);
    expect(out.vendor).toBe('openai');
    expect(openai.deepResearch).toHaveBeenCalled();
  });

  it('effort=highest → OpenAI o3-deep-research primary (Google Max disabled until GCP GA)', async () => {
    const { router, openai, google } = buildRouter();
    const out = await router.deepResearch({ question: 'q', reasoningEffort: 'highest' }, ctx);
    expect(out.vendor).toBe('openai');
    expect(google.deepResearch).not.toHaveBeenCalled();
    expect(openai.deepResearch).toHaveBeenCalled();
  });

  it('default effort is low (Perplexity)', async () => {
    const { router, perplexity } = buildRouter();
    const out = await router.deepResearch({ question: 'q' }, ctx);
    expect(out.vendor).toBe('perplexity');
    expect(perplexity.deepResearch).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: 'high' }),
      expect.anything(),
    );
  });
});

describe('Migration flag ON — fallback chains', () => {
  it('medium, google fails → Perplexity fallback at fixed effort=high (D5)', async () => {
    const { router, perplexity } = buildRouter({ googleFails: true });
    const out = await router.deepResearch({ question: 'q', reasoningEffort: 'medium' }, ctx);
    expect(out.vendor).toBe('perplexity');
    expect(perplexity.deepResearch).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: 'high' }),
      expect.anything(),
    );
  });

  it('high, openai fails → Perplexity fallback at fixed effort=high', async () => {
    const { router, perplexity } = buildRouter({ openaiFails: true });
    const out = await router.deepResearch({ question: 'q', reasoningEffort: 'high' }, ctx);
    expect(out.vendor).toBe('perplexity');
    expect(perplexity.deepResearch).toHaveBeenCalledWith(
      expect.objectContaining({ reasoningEffort: 'high' }),
      expect.anything(),
    );
  });
});

describe('Per-tenant Google exclusion (D13) [Google hard-disabled globally; per-tenant flag tautological for now]', () => {
  it('medium + google per-tenant excluded → Perplexity (same as default)', async () => {
    mockIsVendorExcludedForTenant.mockResolvedValue(true);
    const { router, perplexity, google } = buildRouter();
    const out = await router.deepResearch({ question: 'q', reasoningEffort: 'medium' }, ctx);
    expect(out.vendor).toBe('perplexity');
    expect(google.deepResearch).not.toHaveBeenCalled();
    expect(perplexity.deepResearch).toHaveBeenCalled();
  });

  it('highest + google per-tenant excluded → OpenAI (same as default)', async () => {
    mockIsVendorExcludedForTenant.mockResolvedValue(true);
    const { router, openai, google } = buildRouter();
    const out = await router.deepResearch({ question: 'q', reasoningEffort: 'highest' }, ctx);
    expect(out.vendor).toBe('openai');
    expect(google.deepResearch).not.toHaveBeenCalled();
    expect(openai.deepResearch).toHaveBeenCalled();
  });
});

describe('Admission-block fallback (D12)', () => {
  // Google is hard-disabled at the router level until GCP GAs Deep Research.
  // Active chains: medium=['perplexity'], high=['openai','perplexity'],
  // highest=['openai']. Tests use `high` to exercise the 2-element fallback.

  it('token-bucket exhausted on OpenAI primary (high) → falls through to Perplexity', async () => {
    mockConsumeToken
      .mockResolvedValueOnce({ ok: false, retryAfterMs: 2000 })
      .mockResolvedValueOnce({ ok: true });
    const { router, perplexity } = buildRouter();
    const out = await router.deepResearch({ question: 'q', reasoningEffort: 'high' }, ctx);
    expect(out.vendor).toBe('perplexity');
    expect(perplexity.deepResearch).toHaveBeenCalled();
  });

  it('inflight-slot VendorPoolBusy on OpenAI primary (high) → falls through to Perplexity', async () => {
    mockAcquireInflightSlot
      .mockRejectedValueOnce(new VendorPoolBusy('openai', 2000))
      .mockResolvedValueOnce({ requestId: 'rid', release: jest.fn().mockResolvedValue(undefined), refresh: jest.fn().mockResolvedValue({ refreshed: true }) });
    const { router, perplexity } = buildRouter();
    const out = await router.deepResearch({ question: 'q', reasoningEffort: 'high' }, ctx);
    expect(out.vendor).toBe('perplexity');
    expect(perplexity.deepResearch).toHaveBeenCalled();
  });

  it('LAST chain entry hits VendorPoolBusy → surfaces (no further fallback)', async () => {
    // high chain = ['openai', 'perplexity']. Both busy → second surfaces.
    mockAcquireInflightSlot
      .mockRejectedValueOnce(new VendorPoolBusy('openai', 2000))
      .mockRejectedValueOnce(new VendorPoolBusy('perplexity', 3000));
    const { router } = buildRouter();
    await expect(router.deepResearch({ question: 'q', reasoningEffort: 'high' }, ctx))
      .rejects.toMatchObject({ vendor: 'perplexity' });
  });

  it('regression: non-deepResearch (no fallbackOnAdmissionBlock) surfaces VendorPoolBusy immediately', async () => {
    mockAcquireInflightSlot.mockRejectedValueOnce(new VendorPoolBusy('perplexity', 1000));
    const { router } = buildRouter();
    await expect(router.fetch({ url: 'https://x' }, ctx)).rejects.toMatchObject({ vendor: 'perplexity' });
  });
});

describe('All vendors disabled', () => {
  it('throws "backends unavailable for reasoning_effort=…"', async () => {
    mockIsVendorEnabled.mockResolvedValue(false);
    const { router } = buildRouter();
    await expect(router.deepResearch({ question: 'q', reasoningEffort: 'highest' }, ctx))
      .rejects.toThrow(/backends unavailable for reasoning_effort=highest/);
  });
});
