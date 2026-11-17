const mockPublishWebToolEvent = jest.fn();
const mockGetWebToolSecret = jest.fn();
const mockSelectDueForReconciliation = jest.fn();
const mockFinalizeSubmission = jest.fn();
const mockMarkPolled = jest.fn();
const mockEnqueueOutbox = jest.fn();
const mockSweepFinalizedSubmissions = jest.fn();
const originalFetch = global.fetch;

jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
jest.mock('../web-tool-secrets', () => ({
  getWebToolSecret: (...a: unknown[]) => mockGetWebToolSecret(...a),
}));
jest.mock('../event-publisher', () => ({
  publishWebToolEvent: (...a: unknown[]) => mockPublishWebToolEvent(...a),
}));
jest.mock('../deep-research-outbox', () => ({
  enqueueOutbox: (...a: unknown[]) => mockEnqueueOutbox(...a),
}));
jest.mock('../deep-research-registry', () => ({
  selectDueForReconciliation: (...a: unknown[]) => mockSelectDueForReconciliation(...a),
  finalizeSubmission:         (...a: unknown[]) => mockFinalizeSubmission(...a),
  markPolled:                 (...a: unknown[]) => mockMarkPolled(...a),
  sweepFinalizedSubmissions:  (...a: unknown[]) => mockSweepFinalizedSubmissions(...a),
}));

import { reconcileOnce, startReconciler, stopReconciler } from '../deep-research-reconciler';

beforeEach(() => {
  jest.clearAllMocks();
  mockGetWebToolSecret.mockResolvedValue('api-key');
  mockPublishWebToolEvent.mockResolvedValue(true);
  mockSweepFinalizedSubmissions.mockResolvedValue(0);
  // Registry helpers are async — must resolve so `await markPolled(...).catch(...)`
  // and `await finalizeSubmission(...)` don't synchronously throw on `undefined.catch`.
  mockMarkPolled.mockResolvedValue(undefined);
  mockFinalizeSubmission.mockResolvedValue(undefined);
  mockEnqueueOutbox.mockResolvedValue(undefined);
});
afterAll(() => { global.fetch = originalFetch; });

const ROW = {
  deepResearchId:     'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  submissionId:       'sub-perplexity-xyz',
  tenantId:           'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb',
  agentId:            'cccccccc-cccc-cccc-cccc-cccccccccccc',
  vendor:             'perplexity' as const,
  reasoningEffort:    'medium' as const,
  estimateCostMicros: 400_000,
  submittedAt:        new Date(Date.now() - 10 * 60 * 1000),  // 10min ago
  lastPolledAt:       null,
  polledCount:        0,
  finalStatus:        null,
  finalCostMicros:    null,
  finalizedAt:        null,
};

const OPENAI_ROW = {
  ...ROW,
  deepResearchId:     'dddddddd-dddd-dddd-dddd-dddddddddddd',
  submissionId:       'oai-resp-1',
  vendor:             'openai' as const,
  reasoningEffort:    'high' as const,
  estimateCostMicros: 3_000_000,
};

const GOOGLE_ROW = {
  ...ROW,
  deepResearchId:     'eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee',
  submissionId:       'g-int-1',
  vendor:             'google' as const,
  reasoningEffort:    'high' as const,
  estimateCostMicros: 7_000_000,
};

describe('reconcileOnce — COMPLETED path', () => {
  it('fetches Perplexity, emits delta, finalizes registry row', async () => {
    mockSelectDueForReconciliation.mockResolvedValueOnce([ROW]);
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        status: 'COMPLETED',
        response: {
          choices: [{ message: { content: 'report markdown' } }],
          search_results: [],
          usage: {
            prompt_tokens: 1000, completion_tokens: 500,
            citation_tokens: 100, reasoning_tokens: 50_000,
            num_search_queries: 30,
            cost: { currency: 'USD', total_cost: 0.65 },
          },
        },
      }),
    }) as unknown as typeof fetch;
    const summary = await reconcileOnce();

    expect(summary).toMatchObject({ selected: 1, completed: 1, failed: 0, abandoned: 0, pending: 0, unreachable: 0, errors: 0 });
    expect(mockMarkPolled).toHaveBeenCalledWith(ROW.deepResearchId);

    // emitPair publishes BOTH pre-charge and delta (Gap #2).
    expect(mockPublishWebToolEvent).toHaveBeenCalledTimes(2);
    const calls = mockPublishWebToolEvent.mock.calls.map(c => c[0]);
    const precharge = calls.find(c => c.idempotencyKey === ROW.deepResearchId);
    const delta     = calls.find(c => c.idempotencyKey === `${ROW.deepResearchId}/delta`);
    expect(precharge).toMatchObject({
      connector: 'perplexity',
      eventType: 'web_deep_research',
      costUsd:   ROW.estimateCostMicros / 1_000_000,
      metadata:  expect.objectContaining({ is_pre_charge: true, reconciler_source: true }),
    });
    expect(delta).toMatchObject({
      connector: 'perplexity',
      eventType: 'web_deep_research',
      costUsd:   (650_000 - 400_000) / 1_000_000,
      metadata:  expect.objectContaining({
        is_delta:           true,
        reconciler_source:  true,
        final_status:       'COMPLETED',
        actual_cost_micros: 650_000,
      }),
    });
    expect(mockFinalizeSubmission).toHaveBeenCalledWith({
      deepResearchId:  ROW.deepResearchId,
      finalStatus:     'completed',
      finalCostMicros: 650_000,
    });
  });
});

describe('reconcileOnce — FAILED path (Gap #3)', () => {
  it('extracts partial cost from usage.cost.total_cost when present', async () => {
    mockSelectDueForReconciliation.mockResolvedValueOnce([ROW]);
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        status: 'FAILED',
        response: {
          choices: [],
          usage: { cost: { currency: 'USD', total_cost: 0.20 } },
        },
        error_message: 'some upstream error',
      }),
    }) as unknown as typeof fetch;
    const summary = await reconcileOnce();
    expect(summary.failed).toBe(1);
    const delta = mockPublishWebToolEvent.mock.calls
      .map(c => c[0])
      .find(c => c.idempotencyKey === `${ROW.deepResearchId}/delta`);
    expect(delta.metadata.actual_cost_micros).toBe(200_000);
    expect(mockFinalizeSubmission).toHaveBeenCalledWith({
      deepResearchId:  ROW.deepResearchId,
      finalStatus:     'failed',
      finalCostMicros: 200_000,
    });
  });

  it('defaults to 0 actual cost when response is null', async () => {
    mockSelectDueForReconciliation.mockResolvedValueOnce([ROW]);
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ status: 'FAILED', response: null, error_message: 'failed' }),
    }) as unknown as typeof fetch;
    const summary = await reconcileOnce();
    expect(summary.failed).toBe(1);
    expect(mockFinalizeSubmission).toHaveBeenCalledWith({
      deepResearchId:  ROW.deepResearchId,
      finalStatus:     'failed',
      finalCostMicros: 0,
    });
  });
});

describe('reconcileOnce — COMPLETED with null response (Gap #4)', () => {
  it('treats COMPLETED + null response as FAILED', async () => {
    mockSelectDueForReconciliation.mockResolvedValueOnce([ROW]);
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ status: 'COMPLETED', response: null }),
    }) as unknown as typeof fetch;
    const summary = await reconcileOnce();
    expect(summary.failed).toBe(1);
    expect(mockFinalizeSubmission).toHaveBeenCalledWith({
      deepResearchId:  ROW.deepResearchId,
      finalStatus:     'failed',
      finalCostMicros: 0,
    });
  });
});

describe('reconcileOnce — abandon after 24h', () => {
  it('emits ABANDONED pair and finalizes after 24h', async () => {
    const oldRow = { ...ROW, submittedAt: new Date(Date.now() - (25 * 60 * 60 * 1000)) };
    mockSelectDueForReconciliation.mockResolvedValueOnce([oldRow]);
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ status: 'IN_PROGRESS', response: null }),
    }) as unknown as typeof fetch;
    const summary = await reconcileOnce();
    expect(summary.abandoned).toBe(1);
    expect(mockFinalizeSubmission).toHaveBeenCalledWith({
      deepResearchId:  ROW.deepResearchId,
      finalStatus:     'abandoned',
      finalCostMicros: 0,
    });
  });
});

describe('reconcileOnce — Perplexity unreachable (Gap #9)', () => {
  it('returns unreachable outcome when fetch throws, row left unresolved', async () => {
    mockSelectDueForReconciliation.mockResolvedValueOnce([ROW]);
    global.fetch = jest.fn().mockRejectedValueOnce(new Error('ECONNRESET')) as unknown as typeof fetch;
    const summary = await reconcileOnce();
    expect(summary.unreachable).toBe(1);
    expect(summary.errors).toBe(0);
    expect(mockFinalizeSubmission).not.toHaveBeenCalled();
  });
});

describe('reconcileOnce — pending', () => {
  it('returns pending outcome when IN_PROGRESS and < 24h', async () => {
    mockSelectDueForReconciliation.mockResolvedValueOnce([ROW]);
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ status: 'IN_PROGRESS', response: null }),
    }) as unknown as typeof fetch;
    const summary = await reconcileOnce();
    expect(summary.pending).toBe(1);
    expect(mockFinalizeSubmission).not.toHaveBeenCalled();
  });
});

describe('reconcileOnce — Perplexity 404', () => {
  it('treats 404 as FAILED', async () => {
    mockSelectDueForReconciliation.mockResolvedValueOnce([ROW]);
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: false, status: 404,
      json: async () => ({}),
    }) as unknown as typeof fetch;
    const summary = await reconcileOnce();
    expect(summary.failed).toBe(1);
  });
});

describe('reconcileOnce — publish failure routes to outbox', () => {
  it('enqueues outbox row when publish returns false', async () => {
    mockSelectDueForReconciliation.mockResolvedValueOnce([ROW]);
    mockPublishWebToolEvent.mockResolvedValue(false);
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        status: 'COMPLETED',
        response: {
          choices: [{ message: { content: 'r' } }],
          usage: { cost: { currency: 'USD', total_cost: 0.50 } },
        },
      }),
    }) as unknown as typeof fetch;
    await reconcileOnce();
    expect(mockEnqueueOutbox).toHaveBeenCalledTimes(2);
    const kinds = mockEnqueueOutbox.mock.calls.map(c => c[1]);
    expect(kinds).toEqual(expect.arrayContaining(['pre_charge', 'delta']));
  });
});

describe('reconcileOnce — getWebToolSecret throws', () => {
  it('counts row as unreachable when api-key fetch fails for that vendor', async () => {
    mockSelectDueForReconciliation.mockResolvedValueOnce([ROW]);
    mockGetWebToolSecret.mockRejectedValueOnce(new Error('Secret Manager outage'));
    const summary = await reconcileOnce();
    expect(summary.selected).toBe(1);
    expect(summary.unreachable).toBe(1);
    expect(mockPublishWebToolEvent).not.toHaveBeenCalled();
    expect(mockFinalizeSubmission).not.toHaveBeenCalled();
  });

  it('empty batch short-circuits without resolving any keys', async () => {
    mockSelectDueForReconciliation.mockResolvedValueOnce([]);
    const summary = await reconcileOnce();
    expect(summary).toEqual({ selected: 0, completed: 0, failed: 0, abandoned: 0, pending: 0, unreachable: 0, errors: 0 });
    expect(mockGetWebToolSecret).not.toHaveBeenCalled();
  });
});

describe('startReconciler — env disable (runbook kill-switch)', () => {
  const originalEnv = process.env.DEEP_RESEARCH_RECONCILER_DISABLED;
  afterEach(() => {
    if (originalEnv === undefined) delete process.env.DEEP_RESEARCH_RECONCILER_DISABLED;
    else process.env.DEEP_RESEARCH_RECONCILER_DISABLED = originalEnv;
  });

  it('is a no-op when DEEP_RESEARCH_RECONCILER_DISABLED=true', () => {
    process.env.DEEP_RESEARCH_RECONCILER_DISABLED = 'true';
    const setIntervalSpy = jest.spyOn(global, 'setInterval');
    startReconciler();
    expect(setIntervalSpy).not.toHaveBeenCalled();
    setIntervalSpy.mockRestore();
  });
});

describe('stopReconciler', () => {
  it('resolves quickly when nothing is in flight', async () => {
    const t0 = Date.now();
    await stopReconciler();
    expect(Date.now() - t0).toBeLessThan(100);
  });
});

// ─── Multi-vendor dispatch (migration 236) ──────────────────────────────────

describe('reconcileOnce — OpenAI adapter', () => {
  it('polls /v1/responses/{id}, emits delta with connector=openai, finalizes', async () => {
    mockSelectDueForReconciliation.mockResolvedValueOnce([OPENAI_ROW]);
    const fetchMock = jest.fn().mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        id: OPENAI_ROW.submissionId,
        status: 'completed',
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 100 },
        output: [{ type: 'message', content: [{ type: 'output_text', text: 'r' }] }],
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const summary = await reconcileOnce();
    expect(summary.completed).toBe(1);

    // URL must be OpenAI's endpoint
    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('api.openai.com/v1/responses/');
    expect(url).toContain(OPENAI_ROW.submissionId);

    // Both events carry connector='openai'
    expect(mockPublishWebToolEvent).toHaveBeenCalledTimes(2);
    const calls = mockPublishWebToolEvent.mock.calls.map(c => c[0]);
    expect(calls.every(c => c.connector === 'openai')).toBe(true);

    // Body has zero web_search_calls in output → search fee = 0.
    // Defaults: tokens only = (900*10 + 100*2.5 + 500*40) / 1e6 = 29250 micros
    const delta = calls.find(c => c.idempotencyKey === `${OPENAI_ROW.deepResearchId}/delta`);
    expect(delta.metadata.actual_cost_micros).toBe(29250);
    expect(mockFinalizeSubmission).toHaveBeenCalledWith({
      deepResearchId:  OPENAI_ROW.deepResearchId,
      finalStatus:     'completed',
      finalCostMicros: 29250,
    });
  });

  it('OpenAI completed with web_search_calls → includes per-call fee in cost', async () => {
    mockSelectDueForReconciliation.mockResolvedValueOnce([OPENAI_ROW]);
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        id: OPENAI_ROW.submissionId,
        status: 'completed',
        usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 100 },
        output: [
          { type: 'web_search_call' }, { type: 'web_search_call' }, { type: 'web_search_call' },
          { type: 'message', content: [{ type: 'output_text', text: 'r' }] },
        ],
      }),
    }) as unknown as typeof fetch;
    await reconcileOnce();
    // Tokens 29250 + search 3 × $10/1K = 30000 micros = 59250 total micros
    const delta = mockPublishWebToolEvent.mock.calls
      .map(c => c[0])
      .find(c => c.idempotencyKey === `${OPENAI_ROW.deepResearchId}/delta`);
    expect(delta.metadata.actual_cost_micros).toBe(59250);
  });

  it('OpenAI status=expired → FAILED with partial cost from usage + any search calls already made', async () => {
    mockSelectDueForReconciliation.mockResolvedValueOnce([OPENAI_ROW]);
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        id: OPENAI_ROW.submissionId,
        status: 'expired',
        usage: { input_tokens: 100, output_tokens: 50 },
        error: { message: 'expired' },
      }),
    }) as unknown as typeof fetch;
    const summary = await reconcileOnce();
    expect(summary.failed).toBe(1);
    // No output array → 0 search calls. partial = (100*10 + 50*40) / 1e6 = 3000 micros.
    const delta = mockPublishWebToolEvent.mock.calls
      .map(c => c[0])
      .find(c => c.idempotencyKey === `${OPENAI_ROW.deepResearchId}/delta`);
    expect(delta.metadata.actual_cost_micros).toBe(3000);
  });

  it('OpenAI completed but missing usage → pending (wait for next pass)', async () => {
    mockSelectDueForReconciliation.mockResolvedValueOnce([OPENAI_ROW]);
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ id: OPENAI_ROW.submissionId, status: 'completed' }),
    }) as unknown as typeof fetch;
    const summary = await reconcileOnce();
    expect(summary.pending).toBe(1);
    expect(mockFinalizeSubmission).not.toHaveBeenCalled();
  });

  it('uses openai-api-key secret', async () => {
    mockSelectDueForReconciliation.mockResolvedValueOnce([OPENAI_ROW]);
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ id: OPENAI_ROW.submissionId, status: 'in_progress' }),
    }) as unknown as typeof fetch;
    await reconcileOnce();
    expect(mockGetWebToolSecret).toHaveBeenCalledWith('openai-api-key');
  });
});

describe('reconcileOnce — Google adapter', () => {
  it('polls /v1beta/interactions/{id}, emits delta with connector=google, finalizes', async () => {
    mockSelectDueForReconciliation.mockResolvedValueOnce([GOOGLE_ROW]);
    const fetchMock = jest.fn().mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        id: GOOGLE_ROW.submissionId,
        status: 'completed',
        usage: {
          total_input_tokens: 1000,
          total_output_tokens: 500,
          total_cached_tokens: 100,
          total_thought_tokens: 200,
        },
        steps: [{ content: [{ type: 'text', text: 'r' }] }],
      }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const summary = await reconcileOnce();
    expect(summary.completed).toBe(1);

    const [url] = fetchMock.mock.calls[0];
    expect(url).toContain('generativelanguage.googleapis.com/v1beta/interactions/');
    expect(url).toContain(GOOGLE_ROW.submissionId);
    expect(url).toContain('?key=');

    const calls = mockPublishWebToolEvent.mock.calls.map(c => c[0]);
    expect(calls.every(c => c.connector === 'google')).toBe(true);

    // Gemini 3.1 Pro Preview ≤200K rates: 2.00/0.20/12.00/12.00 ($/1M).
    // (900*2 + 100*0.20 + 500*12 + 200*12) / 1e6
    //   = (1800 + 20 + 6000 + 2400) / 1e6 = 10220 micros
    const delta = calls.find(c => c.idempotencyKey === `${GOOGLE_ROW.deepResearchId}/delta`);
    expect(delta.metadata.actual_cost_micros).toBe(10220);
  });

  it('Google status=budget_exceeded → FAILED (terminal)', async () => {
    mockSelectDueForReconciliation.mockResolvedValueOnce([GOOGLE_ROW]);
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({
        id: GOOGLE_ROW.submissionId,
        status: 'budget_exceeded',
        error: { message: 'over' },
      }),
    }) as unknown as typeof fetch;
    const summary = await reconcileOnce();
    expect(summary.failed).toBe(1);
    expect(mockFinalizeSubmission).toHaveBeenCalledWith({
      deepResearchId:  GOOGLE_ROW.deepResearchId,
      finalStatus:     'failed',
      finalCostMicros: 0,
    });
  });

  it('Google status=cancelled / incomplete → FAILED', async () => {
    mockSelectDueForReconciliation.mockResolvedValueOnce([GOOGLE_ROW]);
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ id: GOOGLE_ROW.submissionId, status: 'cancelled' }),
    }) as unknown as typeof fetch;
    const summary = await reconcileOnce();
    expect(summary.failed).toBe(1);
  });

  it('uses google-api-key secret', async () => {
    mockSelectDueForReconciliation.mockResolvedValueOnce([GOOGLE_ROW]);
    global.fetch = jest.fn().mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ id: GOOGLE_ROW.submissionId, status: 'in_progress' }),
    }) as unknown as typeof fetch;
    await reconcileOnce();
    expect(mockGetWebToolSecret).toHaveBeenCalledWith('google-api-key');
  });
});

describe('reconcileOnce — mixed-vendor batch', () => {
  it('dispatches per-row to the correct adapter URL', async () => {
    mockSelectDueForReconciliation.mockResolvedValueOnce([ROW, OPENAI_ROW, GOOGLE_ROW]);
    const fetchMock = jest.fn()
      // Perplexity poll
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ status: 'IN_PROGRESS', response: null }) })
      // OpenAI poll
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: OPENAI_ROW.submissionId, status: 'in_progress' }) })
      // Google poll
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: GOOGLE_ROW.submissionId, status: 'in_progress' }) });
    global.fetch = fetchMock as unknown as typeof fetch;

    await reconcileOnce();

    const urls = fetchMock.mock.calls.map(c => String(c[0]));
    expect(urls.some(u => u.includes('api.perplexity.ai/async/chat/completions/'))).toBe(true);
    expect(urls.some(u => u.includes('api.openai.com/v1/responses/'))).toBe(true);
    expect(urls.some(u => u.includes('generativelanguage.googleapis.com/v1beta/interactions/'))).toBe(true);

    // All three vendor secrets were resolved
    const secretsCalled = mockGetWebToolSecret.mock.calls.map(c => c[0]);
    expect(secretsCalled).toEqual(expect.arrayContaining(['perplexity-api-key', 'openai-api-key', 'google-api-key']));
  });
});
