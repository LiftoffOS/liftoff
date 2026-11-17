const mockGetSecret = jest.fn();
jest.mock('../../../infrastructure/secrets', () => ({
  getSecret: (...a: unknown[]) => mockGetSecret(...a),
}));
const mockLogger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() };
jest.mock('../../../infrastructure/logging', () => ({ logger: mockLogger }));

const mockGetCachedSentinelFlags = jest.fn();
// CommonJS limitation: `readTypedFlag` in the real `./limits-config` module
// closure-binds its own reference to `getCachedSentinelFlags`. Spreading
// `...actual` and overriding only `getCachedSentinelFlags` therefore leaves
// the internal call in the real `readTypedFlag` pointing at the real impl —
// the rate-table-override path can never be exercised. So we re-implement
// `readTypedFlag` here against the mocked `getCachedSentinelFlags`. Logic is
// trivial (5 lines) and asserted against `mockLogger.warn` below to lock
// the contract.
jest.mock('../limits-config', () => ({
  getCachedSentinelFlags: (...a: unknown[]) => mockGetCachedSentinelFlags(...a),
  readTypedFlag: async <T>(key: string, validate: (raw: unknown) => raw is T, fallback: T): Promise<T> => {
    const flags = await mockGetCachedSentinelFlags();
    const raw = flags[`${key}_value`];
    if (validate(raw)) return raw;
    if (raw !== undefined) {
      mockLogger.warn({ key, raw }, 'sentinel_flag_invalid_using_fallback');
    }
    return fallback;
  },
  isEffortRoutingEnabled: jest.fn().mockResolvedValue(false),
}));

const mockInsertSubmission = jest.fn();
const mockFinalizeSubmission = jest.fn();
const mockMarkPolled = jest.fn();
const mockMarkHookActive = jest.fn();
jest.mock('../deep-research-registry', () => ({
  insertSubmission:   (...a: unknown[]) => mockInsertSubmission(...a),
  finalizeSubmission: (...a: unknown[]) => mockFinalizeSubmission(...a),
  markPolled:         (...a: unknown[]) => mockMarkPolled(...a),
  markHookActive:     (...a: unknown[]) => mockMarkHookActive(...a),
}));

import { OpenAIClient, OpenAIError } from '../openai-client';

const TENANT = 'tenant-uuid-1';
const AGENT  = 'agent-uuid-1';

const originalFetch = global.fetch;
afterAll(() => { global.fetch = originalFetch; });

let setTimeoutSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  mockGetSecret.mockResolvedValue('openai-test-key');
  mockGetCachedSentinelFlags.mockResolvedValue({});
  mockInsertSubmission.mockResolvedValue(undefined);
  mockFinalizeSubmission.mockResolvedValue(undefined);
  mockMarkPolled.mockResolvedValue(undefined);
  mockMarkHookActive.mockResolvedValue(undefined);
  setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
    fn();
    return 0 as unknown as NodeJS.Timeout;
  }) as unknown as typeof setTimeout);
});
afterEach(() => { setTimeoutSpy.mockRestore(); });

function fetchSequence(...responses: Array<{ status: number; body: unknown }>) {
  const fn = jest.fn();
  for (const r of responses) {
    fn.mockResolvedValueOnce({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: 'OK',
      json: async () => r.body,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    });
  }
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

const completedResponse = (overrides: Record<string, unknown> = {}) => ({
  id: 'resp-1',
  status: 'completed',
  usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 100 },
  output: [
    { type: 'web_search_call' },
    { type: 'message', content: [{ type: 'output_text', text: 'final report', annotations: [{ url: 'https://x', title: 'X' }] }] },
  ],
  ...overrides,
});

describe('OpenAIClient.fetch (deepResearch unsupported)', () => {
  it('throws 501 when fetch is invoked', async () => {
    const c = new OpenAIClient();
    await expect(c.fetch({ url: 'https://x' })).rejects.toMatchObject({ statusCode: 501 });
  });
});

describe('OpenAIClient.deepResearch happy path', () => {
  it('submits, polls to completed, returns report+citations, computes cost from tokens', async () => {
    const fn = fetchSequence(
      { status: 200, body: { id: 'resp-1' } },                       // submit
      { status: 200, body: completedResponse() },                    // first poll completed
    );
    const c = new OpenAIClient();
    const out = await c.deepResearch({ question: 'q', reasoningEffort: 'high' });
    expect(out.report).toBe('final report');
    expect(out.sources).toEqual([{ url: 'https://x', title: 'X' }]);
    expect(out.vendor).toBe('openai');
    // Defaults verified against developers.openai.com/api/docs/models/
    // o3-deep-research on 2026-06-03 — the MODEL-specific page (which has
    // its own dedicated rates distinct from the o-series chat models in
    // src/llm/pricing.ts): input $10/M, cached $2.50/M, output $40/M.
    // Web search preview $10/1K calls (reasoning models, aggregate page).
    // Tokens: (900*10 + 100*2.5 + 500*40) / 1e6 = 29250 micros
    // Search: 1 web_search_call × $10/1K = $0.01 = 10000 micros
    // Total: 29250 + 10000 = 39250 micros
    expect(out.costMicros).toBe(39250);
    expect(out.usage.num_search_queries).toBe(1);
    // Submit body must include web_search_preview + fixed max_tool_calls=100 (D6).
    const body = JSON.parse(fn.mock.calls[0][1].body);
    expect(body.tools).toEqual([{ type: 'web_search_preview' }]);
    expect(body.max_tool_calls).toBe(100);
  });

  it('max_tool_calls is fixed at 100 regardless of reasoning_effort (D6)', async () => {
    // Even when the agent's tier is `highest` (OpenAI is the fallback for
    // that tier), OpenAI is configured at the same depth — fixed dial.
    const fn = fetchSequence(
      { status: 200, body: { id: 'resp-2' } },
      { status: 200, body: completedResponse() },
    );
    const c = new OpenAIClient();
    await c.deepResearch({ question: 'q', reasoningEffort: 'highest' });
    const body = JSON.parse(fn.mock.calls[0][1].body);
    expect(body.max_tool_calls).toBe(100);
  });

  it('honors sentinel rate-table override (token rates + per-search-call fee)', async () => {
    mockGetCachedSentinelFlags.mockResolvedValue({
      web_fetch_openai_rates_v1_value: {
        input_per_million: 20,
        cached_per_million: 5,
        output_per_million: 80,
        search_per_thousand_calls: 20,        // 2× default
      },
    });
    fetchSequence(
      { status: 200, body: { id: 'resp-1' } },
      { status: 200, body: completedResponse() },
    );
    const c = new OpenAIClient();
    const out = await c.deepResearch({ question: 'q' });
    // Tokens: (900 * 20 + 100 * 5 + 500 * 80) / 1e6 = 58500 micros
    // Search: 1 call × $20/1K = $0.02 = 20000 micros
    // Total: 58500 + 20000 = 78500 micros
    expect(out.costMicros).toBe(78500);
  });

  it('per-search-call fee scales linearly with web_search_call count', async () => {
    fetchSequence(
      { status: 200, body: { id: 'resp-1' } },
      { status: 200, body: completedResponse({
        // Five web_search_calls in the output
        output: [
          { type: 'web_search_call' },
          { type: 'web_search_call' },
          { type: 'web_search_call' },
          { type: 'web_search_call' },
          { type: 'web_search_call' },
          { type: 'message', content: [{ type: 'output_text', text: 'r', annotations: [] }] },
        ],
      }) },
    );
    const c = new OpenAIClient();
    const out = await c.deepResearch({ question: 'q' });
    // Tokens: 29250 (defaults) + Search: 5 × $0.01 = 50000 micros = 79250 micros
    expect(out.costMicros).toBe(79250);
    expect(out.usage.num_search_queries).toBe(5);
  });

  it('falls back to defaults on invalid rate-table shape AND warn-logs the bad shape', async () => {
    const badShape = { input_per_million: 'oops' };
    mockGetCachedSentinelFlags.mockResolvedValue({
      web_fetch_openai_rates_v1_value: badShape,
    });
    fetchSequence(
      { status: 200, body: { id: 'resp-1' } },
      { status: 200, body: completedResponse() },
    );
    const c = new OpenAIClient();
    const out = await c.deepResearch({ question: 'q' });
    // Defaults: tokens 29250 + search 1×$10/1K = 10000 → 39250 micros
    expect(out.costMicros).toBe(39250);
    // readTypedFlag must surface the contract drift so ops can spot a bad
    // sentinel write before it silently rides the default rates for weeks.
    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.objectContaining({ key: 'web_fetch_openai_rates_v1', raw: badShape }),
      'sentinel_flag_invalid_using_fallback',
    );
  });

  it('rejects partial rate-table override (missing search_per_thousand_calls) and falls back to defaults', async () => {
    // Strict isOpenAIRates: any missing required field falls back to defaults.
    // Catches operators who forgot to add the new search-call rate when
    // updating an existing sentinel write.
    mockGetCachedSentinelFlags.mockResolvedValue({
      web_fetch_openai_rates_v1_value: {
        input_per_million: 20, cached_per_million: 5, output_per_million: 80,
        // search_per_thousand_calls MISSING
      },
    });
    fetchSequence(
      { status: 200, body: { id: 'resp-1' } },
      { status: 200, body: completedResponse() },
    );
    const c = new OpenAIClient();
    const out = await c.deepResearch({ question: 'q' });
    expect(out.costMicros).toBe(39250);   // defaults applied
  });

  it('fires onPreCharge with vendor="openai" and recorded reasoningEffort="high" (D6)', async () => {
    fetchSequence(
      { status: 200, body: { id: 'resp-1' } },
      { status: 200, body: completedResponse() },
    );
    const onPreCharge = jest.fn().mockResolvedValue(undefined);
    const onCompletion = jest.fn().mockResolvedValue(undefined);
    const c = new OpenAIClient();
    await c.deepResearch({ question: 'q', reasoningEffort: 'highest' }, { onPreCharge, onCompletion });
    expect(onPreCharge).toHaveBeenCalledWith(expect.objectContaining({
      vendor: 'openai',
      submissionId: 'resp-1',
      reasoningEffort: 'high',  // fixed; never propagates agent's 'highest'
    }));
    expect(onCompletion).toHaveBeenCalledWith(expect.objectContaining({ vendor: 'openai', status: 'COMPLETED' }));
  });

  it('pre-charge uses single $3 high-tier default (no per-effort table)', async () => {
    fetchSequence(
      { status: 200, body: { id: 'resp-1' } },
      { status: 200, body: completedResponse() },
    );
    const onPreCharge = jest.fn().mockResolvedValue(undefined);
    const c = new OpenAIClient();
    await c.deepResearch({ question: 'q' }, { onPreCharge });
    expect(onPreCharge).toHaveBeenCalledWith(expect.objectContaining({
      estimateCostMicros: 3_000_000,
    }));
  });

  it('pre-charge honors web_fetch_openai_precharge_micros_high_value override', async () => {
    mockGetCachedSentinelFlags.mockResolvedValue({ web_fetch_openai_precharge_micros_high_value: 4_500_000 });
    fetchSequence(
      { status: 200, body: { id: 'resp-1' } },
      { status: 200, body: completedResponse() },
    );
    const onPreCharge = jest.fn().mockResolvedValue(undefined);
    const c = new OpenAIClient();
    await c.deepResearch({ question: 'q' }, { onPreCharge });
    expect(onPreCharge).toHaveBeenCalledWith(expect.objectContaining({
      estimateCostMicros: 4_500_000,
    }));
  });
});

describe('OpenAIClient.deepResearch error paths', () => {
  it('completed but missing usage → OpenAIError(422), NO completion event (matches Perplexity MISSING_COST_STATUS)', async () => {
    fetchSequence(
      { status: 200, body: { id: 'resp-1' } },
      { status: 200, body: { id: 'resp-1', status: 'completed' } },                 // no usage
    );
    const onCompletion = jest.fn().mockResolvedValue(undefined);
    const c = new OpenAIClient();
    const err = await c.deepResearch({ question: 'q' }, { onCompletion }).catch(e => e);
    expect(err).toBeInstanceOf(OpenAIError);
    expect((err as OpenAIError).statusCode).toBe(422);
    // No FAILED refund — pre-charge stays in place; cleanup cron sweeps if no delta lands.
    expect(onCompletion).not.toHaveBeenCalled();
  });

  it('completed with non-finite computed cost → OpenAIError(422), NO completion event', async () => {
    fetchSequence(
      { status: 200, body: { id: 'resp-1' } },
      // Massive negative input_tokens — synthetic shape drift to exercise the
      // !Number.isFinite || usd<0 guard inside computeCostMicros.
      { status: 200, body: { id: 'resp-1', status: 'completed',
        usage: { input_tokens: Number.NaN, output_tokens: 0 },
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'r' }] }] } },
    );
    const onCompletion = jest.fn().mockResolvedValue(undefined);
    const c = new OpenAIClient();
    const err = await c.deepResearch({ question: 'q' }, { onCompletion }).catch(e => e);
    expect(err).toBeInstanceOf(OpenAIError);
    expect((err as OpenAIError).statusCode).toBe(422);
    expect(onCompletion).not.toHaveBeenCalled();
  });

  it('expired status → OpenAIError(408) and FAILED refund delta', async () => {
    fetchSequence(
      { status: 200, body: { id: 'resp-1' } },
      { status: 200, body: { id: 'resp-1', status: 'expired', error: { message: 'gone' } } },
    );
    const onCompletion = jest.fn().mockResolvedValue(undefined);
    const c = new OpenAIClient();
    const err = await c.deepResearch({ question: 'q' }, { onCompletion }).catch(e => e);
    expect(err).toBeInstanceOf(OpenAIError);
    expect((err as OpenAIError).statusCode).toBe(408);
    expect(onCompletion).toHaveBeenCalledWith(expect.objectContaining({ status: 'FAILED', vendor: 'openai' }));
  });

  it('failed status → OpenAIError(500) and FAILED refund delta', async () => {
    fetchSequence(
      { status: 200, body: { id: 'resp-1' } },
      { status: 200, body: { id: 'resp-1', status: 'failed', error: { message: 'bad' } } },
    );
    const onCompletion = jest.fn().mockResolvedValue(undefined);
    const c = new OpenAIClient();
    const err = await c.deepResearch({ question: 'q' }, { onCompletion }).catch(e => e);
    expect((err as OpenAIError).statusCode).toBe(500);
    expect(onCompletion).toHaveBeenCalledWith(expect.objectContaining({ status: 'FAILED' }));
  });
});

describe('OpenAIClient parsing helpers', () => {
  it('extractText picks LAST message item', async () => {
    fetchSequence(
      { status: 200, body: { id: 'resp-1' } },
      { status: 200, body: completedResponse({
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'first' }] },
          { type: 'web_search_call' },
          { type: 'message', content: [{ type: 'output_text', text: 'last' }] },
        ],
      }) },
    );
    const c = new OpenAIClient();
    const out = await c.deepResearch({ question: 'q' });
    expect(out.report).toBe('last');
  });

  it('extractCitations walks annotations across all messages', async () => {
    fetchSequence(
      { status: 200, body: { id: 'resp-1' } },
      { status: 200, body: completedResponse({
        output: [
          { type: 'message', content: [{ type: 'output_text', text: 'a', annotations: [{ url: 'https://1' }, { url: 'https://2' }] }] },
          { type: 'message', content: [{ type: 'output_text', text: 'b', annotations: [{ url: 'https://3' }] }] },
        ],
      }) },
    );
    const c = new OpenAIClient();
    const out = await c.deepResearch({ question: 'q' });
    expect(out.sources.map(s => s.url).sort()).toEqual(['https://1', 'https://2', 'https://3']);
  });
});

describe('OpenAIClient — registry integration', () => {
  it('writes registry row with vendor=openai, effort=high, after submit and before pre-charge', async () => {
    fetchSequence(
      { status: 200, body: { id: 'resp-1' } },
      { status: 200, body: completedResponse() },
    );
    const onPreCharge = jest.fn().mockResolvedValue(undefined);
    const c = new OpenAIClient();
    await c.deepResearch({ question: 'q', tenantId: TENANT, agentId: AGENT }, { onPreCharge });

    expect(mockInsertSubmission).toHaveBeenCalledWith(expect.objectContaining({
      vendor:             'openai',
      tenantId:           TENANT,
      agentId:            AGENT,
      submissionId:       'resp-1',
      reasoningEffort:    'high',
      estimateCostMicros: 3_000_000,
    }));
  });

  it('finalizes registry with completed status + actual cost on COMPLETED', async () => {
    fetchSequence(
      { status: 200, body: { id: 'resp-1' } },
      { status: 200, body: completedResponse() },
    );
    const c = new OpenAIClient();
    await c.deepResearch({ question: 'q', tenantId: TENANT, agentId: AGENT });
    expect(mockFinalizeSubmission).toHaveBeenCalledWith({
      deepResearchId:  expect.any(String),
      finalStatus:     'completed',
      finalCostMicros: 39250,
    });
  });

  it('finalizes registry with failed status on expired', async () => {
    fetchSequence(
      { status: 200, body: { id: 'resp-1' } },
      { status: 200, body: { id: 'resp-1', status: 'expired', error: { message: 'gone' } } },
    );
    const c = new OpenAIClient();
    await c.deepResearch({ question: 'q', tenantId: TENANT }).catch(() => {});
    expect(mockFinalizeSubmission).toHaveBeenCalledWith({
      deepResearchId:  expect.any(String),
      finalStatus:     'failed',
      finalCostMicros: 0,
    });
  });

  it('completed but missing usage → DOES NOT finalize (reconciler picks up)', async () => {
    fetchSequence(
      { status: 200, body: { id: 'resp-1' } },
      { status: 200, body: { id: 'resp-1', status: 'completed' } },
    );
    const c = new OpenAIClient();
    await c.deepResearch({ question: 'q', tenantId: TENANT }).catch(() => {});
    expect(mockFinalizeSubmission).not.toHaveBeenCalled();
  });

  it('markPolled fires on 408 ceiling (timeout)', async () => {
    // Submit succeeds; every subsequent poll says in_progress so the loop
    // exhausts maxWaitMs and reaches the !final branch.
    const fn = jest.fn();
    fn.mockResolvedValueOnce({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ id: 'resp-1' }),
      text: async () => '',
    });
    fn.mockResolvedValue({
      ok: true, status: 200, statusText: 'OK',
      json: async () => ({ id: 'resp-1', status: 'in_progress' }),
      text: async () => '',
    });
    global.fetch = fn as unknown as typeof fetch;
    const c = new OpenAIClient();
    // maxWaitMs=1 — with mocked setTimeout firing synchronously the loop
    // bounces a few iterations before real-clock elapsed exceeds 1ms.
    await c.deepResearch({ question: 'q', tenantId: TENANT, maxWaitMs: 1 }).catch(() => {});
    expect(mockMarkPolled).toHaveBeenCalledWith(expect.any(String));
  });

  it('markHookActive fires every poll iteration when tenantId present', async () => {
    fetchSequence(
      { status: 200, body: { id: 'resp-1' } },
      { status: 200, body: completedResponse() },
    );
    const c = new OpenAIClient();
    await c.deepResearch({ question: 'q', tenantId: TENANT });
    expect(mockMarkHookActive).toHaveBeenCalled();
    expect(mockMarkHookActive.mock.calls[0][1]).toBe(30);   // 30s ttl
  });

  it('skips registry entirely when tenantId is absent', async () => {
    fetchSequence(
      { status: 200, body: { id: 'resp-1' } },
      { status: 200, body: completedResponse() },
    );
    const c = new OpenAIClient();
    await c.deepResearch({ question: 'q' });    // no tenantId
    expect(mockInsertSubmission).not.toHaveBeenCalled();
    expect(mockFinalizeSubmission).not.toHaveBeenCalled();
    expect(mockMarkHookActive).not.toHaveBeenCalled();
  });
});
