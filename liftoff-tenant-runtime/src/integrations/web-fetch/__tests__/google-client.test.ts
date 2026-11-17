const mockGetSecret = jest.fn();
jest.mock('../../../infrastructure/secrets', () => ({
  getSecret: (...a: unknown[]) => mockGetSecret(...a),
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockGetCachedSentinelFlags = jest.fn();
// CommonJS limitation — see openai-client.test.ts for the rationale. Real
// `readTypedFlag` closure-binds the real `getCachedSentinelFlags`, so the
// spread-actual pattern doesn't intercept it. Re-implement against the mock.
jest.mock('../limits-config', () => ({
  getCachedSentinelFlags: (...a: unknown[]) => mockGetCachedSentinelFlags(...a),
  readTypedFlag: async <T>(key: string, validate: (raw: unknown) => raw is T, fallback: T): Promise<T> => {
    const flags = await mockGetCachedSentinelFlags();
    const raw = flags[`${key}_value`];
    if (validate(raw)) return raw;
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

import { GoogleClient, GoogleError } from '../google-client';

const TENANT = 'tenant-uuid-1';
const AGENT  = 'agent-uuid-1';

const originalFetch = global.fetch;
afterAll(() => { global.fetch = originalFetch; });

let setTimeoutSpy: jest.SpyInstance;
beforeEach(() => {
  jest.clearAllMocks();
  mockGetSecret.mockResolvedValue('google-test-key');
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

const completedInteraction = (overrides: Record<string, unknown> = {}) => ({
  id: 'int-1',
  status: 'completed',
  usage: {
    total_input_tokens: 1000,
    total_output_tokens: 500,
    total_cached_tokens: 100,
    total_thought_tokens: 200,
  },
  steps: [
    { type: 'tool_call', content: [] },
    { type: 'model_output', content: [{ type: 'text', text: 'final', annotations: [{ url: 'https://x', title: 'X' }] }] },
  ],
  ...overrides,
});

describe('GoogleClient.fetch (unsupported)', () => {
  it('throws 501', async () => {
    const c = new GoogleClient();
    await expect(c.fetch({ url: 'https://x' })).rejects.toMatchObject({ statusCode: 501 });
  });
});

describe('GoogleClient.deepResearch agent selection (D22 — variant param)', () => {
  it('variant=standard → deep-research-preview-04-2026 agent in submit body (standard Deep Research model)', async () => {
    const fn = fetchSequence(
      { status: 200, body: { id: 'int-1' } },
      { status: 200, body: completedInteraction() },
    );
    const c = new GoogleClient();
    await c.deepResearch({ question: 'q', variant: 'standard' });
    const submitBody = JSON.parse(fn.mock.calls[0][1].body);
    expect(submitBody.agent).toBe('deep-research-preview-04-2026');
    expect(submitBody.tools).toEqual([
      { type: 'google_search' }, { type: 'url_context' }, { type: 'code_execution' },
    ]);
  });

  it('variant=max → max agent in submit body', async () => {
    const fn = fetchSequence(
      { status: 200, body: { id: 'int-1' } },
      { status: 200, body: completedInteraction() },
    );
    const c = new GoogleClient();
    await c.deepResearch({ question: 'q', variant: 'max' });
    const submitBody = JSON.parse(fn.mock.calls[0][1].body);
    expect(submitBody.agent).toBe('deep-research-max-preview-04-2026');
  });
});

describe('GoogleClient.deepResearch happy path', () => {
  it('computes cost from token usage × rate-table', async () => {
    fetchSequence(
      { status: 200, body: { id: 'int-1' } },
      { status: 200, body: completedInteraction() },
    );
    const c = new GoogleClient();
    const out = await c.deepResearch({ question: 'q', variant: 'standard' });
    // Gemini 3.1 Pro Preview ≤200K rates verified against
    // ai.google.dev/gemini-api/docs/pricing 2026-06-03 ($/1M): input 2.00,
    // cached 0.20, output 12.00, thought 12.00 (included in output rate).
    // (900*2 + 100*0.20 + 500*12 + 200*12) / 1e6
    //   = (1800 + 20 + 6000 + 2400) / 1e6 = 0.010220 USD = 10220 micros
    expect(out.costMicros).toBe(10220);
    expect(out.vendor).toBe('google');
    expect(out.sources).toEqual([{ url: 'https://x', title: 'X' }]);
    expect(out.report).toBe('final');
    expect(out.usage.reasoning_tokens).toBe(200);
  });

  it('standard variant: pre-charge $3 + recorded effort="medium"', async () => {
    fetchSequence(
      { status: 200, body: { id: 'int-1' } },
      { status: 200, body: completedInteraction() },
    );
    const onPreCharge = jest.fn().mockResolvedValue(undefined);
    const onCompletion = jest.fn().mockResolvedValue(undefined);
    const c = new GoogleClient();
    await c.deepResearch({ question: 'q', variant: 'standard' }, { onPreCharge, onCompletion });
    expect(onPreCharge).toHaveBeenCalledWith(expect.objectContaining({
      vendor: 'google',
      estimateCostMicros: 3_000_000,
      reasoningEffort: 'medium',
    }));
  });

  it('max variant: pre-charge $7 + recorded effort="high"', async () => {
    fetchSequence(
      { status: 200, body: { id: 'int-1' } },
      { status: 200, body: completedInteraction() },
    );
    const onPreCharge = jest.fn().mockResolvedValue(undefined);
    const c = new GoogleClient();
    await c.deepResearch({ question: 'q', variant: 'max' }, { onPreCharge });
    expect(onPreCharge).toHaveBeenCalledWith(expect.objectContaining({
      estimateCostMicros: 7_000_000,
      reasoningEffort: 'high',
    }));
  });
});

describe('GoogleClient.deepResearch terminal-status paths', () => {
  it('budget_exceeded → GoogleError(429) + refund delta', async () => {
    fetchSequence(
      { status: 200, body: { id: 'int-1' } },
      { status: 200, body: { id: 'int-1', status: 'budget_exceeded', error: { message: 'over' } } },
    );
    const onCompletion = jest.fn().mockResolvedValue(undefined);
    const c = new GoogleClient();
    const err = await c.deepResearch({ question: 'q', variant: 'standard' }, { onCompletion }).catch(e => e);
    expect(err).toBeInstanceOf(GoogleError);
    expect((err as GoogleError).statusCode).toBe(429);
    expect(onCompletion).toHaveBeenCalledWith(expect.objectContaining({ status: 'FAILED', vendor: 'google' }));
  });

  it('failed status → GoogleError(500) + refund delta', async () => {
    fetchSequence(
      { status: 200, body: { id: 'int-1' } },
      { status: 200, body: { id: 'int-1', status: 'failed', error: { message: 'bad' } } },
    );
    const onCompletion = jest.fn().mockResolvedValue(undefined);
    const c = new GoogleClient();
    const err = await c.deepResearch({ question: 'q', variant: 'standard' }, { onCompletion }).catch(e => e);
    expect((err as GoogleError).statusCode).toBe(500);
    expect(onCompletion).toHaveBeenCalledWith(expect.objectContaining({ status: 'FAILED' }));
  });

  it('cancelled / incomplete → GoogleError(500) + refund delta', async () => {
    fetchSequence(
      { status: 200, body: { id: 'int-1' } },
      { status: 200, body: { id: 'int-1', status: 'cancelled' } },
    );
    const c = new GoogleClient();
    const err = await c.deepResearch({ question: 'q', variant: 'standard' }).catch(e => e);
    expect((err as GoogleError).statusCode).toBe(500);
  });

  it('completed but missing usage → GoogleError(422), NO completion event', async () => {
    fetchSequence(
      { status: 200, body: { id: 'int-1' } },
      { status: 200, body: { id: 'int-1', status: 'completed' } },
    );
    const onCompletion = jest.fn().mockResolvedValue(undefined);
    const c = new GoogleClient();
    const err = await c.deepResearch({ question: 'q', variant: 'standard' }, { onCompletion }).catch(e => e);
    expect(err).toBeInstanceOf(GoogleError);
    expect((err as GoogleError).statusCode).toBe(422);
    // Same MISSING_COST_STATUS pattern as Perplexity/OpenAI — pre-charge
    // stays in place; cleanup cron handles orphan if no delta arrives.
    expect(onCompletion).not.toHaveBeenCalled();
  });
});

describe('GoogleClient parsing', () => {
  it('extractText picks LAST step with text content', async () => {
    fetchSequence(
      { status: 200, body: { id: 'int-1' } },
      { status: 200, body: completedInteraction({
        steps: [
          { content: [{ type: 'text', text: 'first' }] },
          { content: [{ type: 'text', text: 'last' }] },
        ],
      }) },
    );
    const c = new GoogleClient();
    const out = await c.deepResearch({ question: 'q', variant: 'standard' });
    expect(out.report).toBe('last');
  });

  it('rate override honored (full tier-aware struct)', async () => {
    mockGetCachedSentinelFlags.mockResolvedValue({
      web_fetch_google_rates_v1_value: {
        under_200k: {
          input_per_million: 2, cached_per_million: 0.5,
          output_per_million: 10, thought_per_million: 10,
        },
        over_200k: {
          input_per_million: 4, cached_per_million: 1.0,
          output_per_million: 20, thought_per_million: 20,
        },
      },
    });
    fetchSequence(
      { status: 200, body: { id: 'int-1' } },
      { status: 200, body: completedInteraction() },     // 1000 input → under_200k
    );
    const c = new GoogleClient();
    const out = await c.deepResearch({ question: 'q', variant: 'standard' });
    // under_200k applies (1000 < 200k):
    // (900*2 + 100*0.5 + 500*10 + 200*10) / 1e6 = 0.00885 USD = 8850 micros
    expect(out.costMicros).toBe(8850);
  });

  it('rejects partial rate-table override (missing tier) and falls back to defaults', async () => {
    mockGetCachedSentinelFlags.mockResolvedValue({
      web_fetch_google_rates_v1_value: {
        under_200k: { input_per_million: 2, cached_per_million: 0.5, output_per_million: 10, thought_per_million: 10 },
        // over_200k MISSING
      },
    });
    fetchSequence(
      { status: 200, body: { id: 'int-1' } },
      { status: 200, body: completedInteraction() },
    );
    const c = new GoogleClient();
    const out = await c.deepResearch({ question: 'q', variant: 'standard' });
    expect(out.costMicros).toBe(10220);   // defaults applied (under_200k tier)
  });

  it('switches to over_200k tier when total_input_tokens > 200K', async () => {
    fetchSequence(
      { status: 200, body: { id: 'int-1' } },
      { status: 200, body: completedInteraction({
        usage: {
          total_input_tokens:    300_000,    // crosses 200K breakpoint
          total_output_tokens:    60_000,
          total_cached_tokens:    50_000,
          total_thought_tokens:   10_000,
        },
      }) },
    );
    const c = new GoogleClient();
    const out = await c.deepResearch({ question: 'q', variant: 'max' });
    // over_200k tier: input $4/M, cached $0.40/M, output $18/M, thought $18/M
    // uncached = 300_000 − 50_000 = 250_000
    // (250_000*4 + 50_000*0.40 + 60_000*18 + 10_000*18) / 1e6
    //   = (1_000_000 + 20_000 + 1_080_000 + 180_000) / 1e6
    //   = 2_280_000 / 1e6 = 2.28 USD = 2_280_000 micros
    expect(out.costMicros).toBe(2_280_000);
  });

  it('boundary: exactly 200K input tokens uses under_200k tier (>200K is strict)', async () => {
    fetchSequence(
      { status: 200, body: { id: 'int-1' } },
      { status: 200, body: completedInteraction({
        usage: {
          total_input_tokens:    200_000,
          total_output_tokens:    10_000,
          total_cached_tokens:         0,
          total_thought_tokens:    1_000,
        },
      }) },
    );
    const c = new GoogleClient();
    const out = await c.deepResearch({ question: 'q', variant: 'standard' });
    // under_200k tier (200_000 NOT > 200_000):
    // (200_000*2 + 0 + 10_000*12 + 1_000*12) / 1e6
    //   = (400_000 + 120_000 + 12_000) / 1e6 = 532_000 micros
    expect(out.costMicros).toBe(532_000);
  });
});

describe('GoogleClient — registry integration', () => {
  it('writes registry row with vendor=google + recorded effort matching variant', async () => {
    fetchSequence(
      { status: 200, body: { id: 'int-1' } },
      { status: 200, body: completedInteraction() },
    );
    const c = new GoogleClient();
    await c.deepResearch({ question: 'q', variant: 'standard', tenantId: TENANT, agentId: AGENT });
    expect(mockInsertSubmission).toHaveBeenCalledWith(expect.objectContaining({
      vendor:             'google',
      tenantId:           TENANT,
      agentId:            AGENT,
      submissionId:       'int-1',
      reasoningEffort:    'medium',       // standard variant → 'medium'
      estimateCostMicros: 3_000_000,
    }));
  });

  it('max variant records reasoningEffort=high in registry', async () => {
    fetchSequence(
      { status: 200, body: { id: 'int-1' } },
      { status: 200, body: completedInteraction() },
    );
    const c = new GoogleClient();
    await c.deepResearch({ question: 'q', variant: 'max', tenantId: TENANT });
    expect(mockInsertSubmission).toHaveBeenCalledWith(expect.objectContaining({
      vendor:             'google',
      reasoningEffort:    'high',
      estimateCostMicros: 7_000_000,
    }));
  });

  it('finalizes with completed status + actual cost', async () => {
    fetchSequence(
      { status: 200, body: { id: 'int-1' } },
      { status: 200, body: completedInteraction() },
    );
    const c = new GoogleClient();
    await c.deepResearch({ question: 'q', variant: 'standard', tenantId: TENANT });
    expect(mockFinalizeSubmission).toHaveBeenCalledWith({
      deepResearchId:  expect.any(String),
      finalStatus:     'completed',
      finalCostMicros: 10220,
    });
  });

  it('budget_exceeded → finalize as failed with 0 cost', async () => {
    fetchSequence(
      { status: 200, body: { id: 'int-1' } },
      { status: 200, body: { id: 'int-1', status: 'budget_exceeded', error: { message: 'over' } } },
    );
    const c = new GoogleClient();
    await c.deepResearch({ question: 'q', variant: 'standard', tenantId: TENANT }).catch(() => {});
    expect(mockFinalizeSubmission).toHaveBeenCalledWith({
      deepResearchId:  expect.any(String),
      finalStatus:     'failed',
      finalCostMicros: 0,
    });
  });

  it('markHookActive fires every poll iteration when tenantId present', async () => {
    fetchSequence(
      { status: 200, body: { id: 'int-1' } },
      { status: 200, body: completedInteraction() },
    );
    const c = new GoogleClient();
    await c.deepResearch({ question: 'q', variant: 'standard', tenantId: TENANT });
    expect(mockMarkHookActive).toHaveBeenCalled();
    expect(mockMarkHookActive.mock.calls[0][1]).toBe(30);
  });

  it('skips registry entirely when tenantId is absent', async () => {
    fetchSequence(
      { status: 200, body: { id: 'int-1' } },
      { status: 200, body: completedInteraction() },
    );
    const c = new GoogleClient();
    await c.deepResearch({ question: 'q', variant: 'standard' });
    expect(mockInsertSubmission).not.toHaveBeenCalled();
    expect(mockFinalizeSubmission).not.toHaveBeenCalled();
    expect(mockMarkHookActive).not.toHaveBeenCalled();
  });
});
