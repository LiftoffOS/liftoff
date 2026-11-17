/**
 * web_fetch_advanced handler — Fix F regression coverage.
 *
 * Profile and identity_name are only honoured on the stateful browser path,
 * so the handler MUST reject the call when either is set without a session_id.
 * Silently dropping them would produce an unauthenticated fetch that the
 * agent assumed was authenticated.
 */

jest.mock('../../usage-ledger/service', () => ({
  usageLedgerService: { recordUsage: jest.fn().mockResolvedValue(undefined) },
}));
jest.mock('../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockPoolQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: (...a: unknown[]) => mockPoolQuery(...a) }),
}));

// The router never runs because the handler short-circuits, but we still
// stub it to detect false-positive plumbing.
const mockFetch = jest.fn();
const mockPeopleSearch = jest.fn();
const mockFinanceSearch = jest.fn();
const mockDeepResearch = jest.fn();
jest.mock('../../integrations/web-fetch/router', () => ({
  WebFetchRouter: jest.fn().mockImplementation(() => ({
    fetch: mockFetch,
    peopleSearch: mockPeopleSearch,
    financeSearch: mockFinanceSearch,
    deepResearch: mockDeepResearch,
  })),
  admitSingleVendor: jest.fn(),
}));

const mockIsVendorEnabled = jest.fn();
jest.mock('../../integrations/web-fetch/global-flags', () => ({
  isVendorEnabled: (...a: unknown[]) => mockIsVendorEnabled(...a),
}));

jest.mock('../../integrations/web-fetch/concurrency-limits', () => {
  class VendorPoolBusy extends Error {
    constructor(public vendor: string, public retryAfterMs: number) { super(`vendor_pool_busy:${vendor}`); }
  }
  return { VendorPoolBusy };
});
const mockPublishWebToolEvent = jest.fn();
jest.mock('../../integrations/web-fetch/event-publisher', () => ({
  publishWebToolEvent: (...a: unknown[]) => mockPublishWebToolEvent(...a),
}));
const mockEnqueueOutbox = jest.fn();
jest.mock('../../integrations/web-fetch/deep-research-outbox', () => ({
  enqueueOutbox: (...a: unknown[]) => mockEnqueueOutbox(...a),
}));
const { VendorPoolBusy: MockVendorPoolBusy } = jest.requireMock('../../integrations/web-fetch/concurrency-limits');
jest.mock('../../integrations/web-fetch/webclaw-client', () => ({
  WebClawClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../integrations/web-fetch/firecrawl-client', () => ({
  FirecrawlClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../integrations/web-fetch/perplexity-client', () => ({
  PerplexityClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../integrations/web-fetch/anchor-client', () => ({
  AnchorClient: jest.fn().mockImplementation(() => ({})),
}));
jest.mock('../../integrations/web-fetch/browserbase-client', () => ({
  BrowserbaseClient: jest.fn().mockImplementation(() => ({})),
}));

import { executeStandardTool, type StandardToolContext } from '../standard-tool-handler';

const ctx: StandardToolContext = {
  tenantId: 'tenant-1',
  agentId: 'agent-1',
  memoryScope: { writableLayers: ['individual'], readableLayers: ['individual'], scopeKeys: ['sk'] },
  traceId: 'trace-1',
};

beforeEach(() => {
  jest.clearAllMocks();
  mockPoolQuery.mockResolvedValue({ rows: [] });
  mockIsVendorEnabled.mockResolvedValue(true);
  // publishWebToolEvent now returns Promise<boolean>; default to success so
  // the existing fire-and-forget tests don't trigger outbox fallback.
  mockPublishWebToolEvent.mockResolvedValue(true);
  mockEnqueueOutbox.mockResolvedValue(undefined);
});

describe('web_fetch_advanced — profile/identity require session_id', () => {
  it('rejects when profile is set without session_id', async () => {
    const result = await executeStandardTool(
      'web_fetch_advanced',
      { url: 'https://example.com', profile: 'salesforce-acme' },
      ctx,
    );
    expect(result?.success).toBe(false);
    expect(result?.error).toMatch(/require a session_id/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('rejects when identity_name is set without session_id', async () => {
    const result = await executeStandardTool(
      'web_fetch_advanced',
      { url: 'https://example.com', identity_name: 'sf-prod' },
      ctx,
    );
    expect(result?.success).toBe(false);
    expect(result?.error).toMatch(/require a session_id/);
    expect(mockFetch).not.toHaveBeenCalled();
  });

  it('allows the call when session_id is present with profile', async () => {
    // 1st pool query: checkBrowserSessionTakeover -> getActiveForCallerSession.
    //                 Return empty so the takeover gate is a no-op.
    // 2nd pool query: resolveProfileAndIdentity -> web_profiles lookup.
    //                 Return the vendor_profile_id row.
    mockPoolQuery.mockResolvedValueOnce({ rows: [] });
    mockPoolQuery.mockResolvedValueOnce({ rows: [{ vendor_profile_id: 'vp-1' }] });
    mockFetch.mockResolvedValueOnce({
      content: 'ok', finalUrl: 'https://example.com', sessionId: 'sess-1',
      vendor: 'anchor', costMicros: 0, jsRendered: true,
    });
    const result = await executeStandardTool(
      'web_fetch_advanced',
      { url: 'https://example.com', session_id: 'sess-1', profile: 'salesforce-acme' },
      ctx,
    );
    expect(result?.success).toBe(true);
    expect(mockFetch).toHaveBeenCalled();
  });
});

describe('web_people_search handler', () => {
  it('returns success when perplexity flag on', async () => {
    mockPeopleSearch.mockResolvedValueOnce({
      results: [{ name: 'Alice', sources: ['https://a'] }],
      vendor: 'perplexity',
      costMicros: 5000,
    });
    const result = await executeStandardTool('web_people_search', { query: 'alice' }, ctx);
    expect(result?.success).toBe(true);
    expect((result?.result as { results: unknown[] }).results).toHaveLength(1);
  });

  it('returns "tool unavailable" when perplexity flag off', async () => {
    mockIsVendorEnabled.mockResolvedValue(false);
    const result = await executeStandardTool('web_people_search', { query: 'alice' }, ctx);
    expect(result?.success).toBe(false);
    expect(result?.error).toMatch(/could not be completed/);
  });

  it('maps VendorPoolBusy → { transient: true, retryAfterMs }', async () => {
    mockPeopleSearch.mockRejectedValueOnce(new MockVendorPoolBusy('perplexity', 2000));
    const result = await executeStandardTool('web_people_search', { query: 'alice' }, ctx);
    expect(result?.success).toBe(false);
    expect(result?.transient).toBe(true);
    expect(result?.retryAfterMs).toBe(2000);
  });
});

describe('web_finance_search handler', () => {
  it('returns success when perplexity flag on', async () => {
    mockFinanceSearch.mockResolvedValueOnce({
      results: [{ instrument: 'stock', summary: 's', sources: [] }],
      vendor: 'perplexity',
      costMicros: 5000,
    });
    const result = await executeStandardTool('web_finance_search', { query: 'AAPL' }, ctx);
    expect(result?.success).toBe(true);
  });

  it('returns "tool unavailable" when perplexity flag off', async () => {
    mockIsVendorEnabled.mockResolvedValue(false);
    const result = await executeStandardTool('web_finance_search', { query: 'AAPL' }, ctx);
    expect(result?.success).toBe(false);
    expect(result?.error).toMatch(/could not be completed/);
  });

  it('maps VendorPoolBusy → { transient: true, retryAfterMs }', async () => {
    mockFinanceSearch.mockRejectedValueOnce(new MockVendorPoolBusy('perplexity', 2000));
    const result = await executeStandardTool('web_finance_search', { query: 'AAPL' }, ctx);
    expect(result?.success).toBe(false);
    expect(result?.transient).toBe(true);
    expect(result?.retryAfterMs).toBe(2000);
  });
});

describe('web_deep_research handler', () => {
  // Phase 2 of the deep-research-realtime-billing plan inverts the
  // emission model: a SINGLE completion event is replaced by TWO events,
  // a pre-charge (recordUsage at submit) + a delta (recordUsage at
  // COMPLETED/FAILED). The mock here drives the router's hook callbacks
  // so the handler exercises both paths.
  const DEEP_RESEARCH_ID = '11111111-1111-1111-1111-111111111111';
  const SUBMISSION_ID    = 'task-abc';

  const COMPLETED = {
    report: 'r', sources: [{ url: 'https://a' }],
    vendor: 'perplexity', costMicros: 500_000,
    deepResearchId: DEEP_RESEARCH_ID,
    usage: { prompt_tokens: 100, completion_tokens: 200, citation_tokens: 0, reasoning_tokens: 50, num_search_queries: 3 },
    durationMs: 60_000,
  };

  /** Build a mockDeepResearch implementation that fires the supplied hooks
   *  with realistic shapes (pre-charge $0.40 / delta = actual − estimate).
   *  Returns the final internal result the production code would surface. */
  function driveHappyPath(actualCostMicros: number = 500_000) {
    return async (
      _req: unknown,
      _ctx: unknown,
      hooks: {
        onPreCharge?: (p: unknown) => Promise<void>;
        onCompletion?: (d: unknown) => Promise<void>;
      },
    ) => {
      const estimateCostMicros = 400_000;
      await hooks.onPreCharge?.({
        deepResearchId:    DEEP_RESEARCH_ID,
        reasoningEffort:   'medium',
        estimateCostMicros,
        submittedAt:       new Date('2026-06-02T00:00:00Z'),
        submissionId:      SUBMISSION_ID,
      });
      await hooks.onCompletion?.({
        deepResearchId:    DEEP_RESEARCH_ID,
        actualCostMicros,
        estimateCostMicros,
        deltaCostMicros:   actualCostMicros - estimateCostMicros,
        status:            'COMPLETED',
        submissionId:      SUBMISSION_ID,
      });
      return { ...COMPLETED, costMicros: actualCostMicros };
    };
  }

  it('returns success when perplexity flag on — propagates report + sources', async () => {
    mockDeepResearch.mockImplementationOnce(driveHappyPath());
    const result = await executeStandardTool('web_deep_research', { question: 'q' }, ctx);
    expect(result?.success).toBe(true);
    const r = result?.result as { report: string; sources: unknown[] };
    expect(r.report).toBe('r');
    expect(r.sources).toHaveLength(1);
  });

  it('router surfaces "backend unavailable" when all vendors off (legacy gate removed at handler — D19)', async () => {
    // D19: the handler no longer hard-gates on Perplexity (that would
    // block intermediate/highest from routing to OpenAI/Google when
    // Perplexity is off). The router's "no chain available" throw is the
    // new error surface; the handler catches it and maps to a generic
    // failure message.
    mockIsVendorEnabled.mockResolvedValue(false);
    mockDeepResearch.mockRejectedValueOnce(new Error('web_deep_research backend unavailable'));
    const result = await executeStandardTool('web_deep_research', { question: 'q' }, ctx);
    expect(result?.success).toBe(false);
    expect(result?.error).toBeTruthy();
  });

  it('maps VendorPoolBusy → { transient: true, retryAfterMs }', async () => {
    mockDeepResearch.mockRejectedValueOnce(new MockVendorPoolBusy('perplexity', 2000));
    const result = await executeStandardTool('web_deep_research', { question: 'q' }, ctx);
    expect(result?.success).toBe(false);
    expect(result?.transient).toBe(true);
    expect(result?.retryAfterMs).toBe(2000);
  });

  it('surfaces PerplexityError(408) timeout as { success: false, error } — NOT transient (408 excluded by isTransient per TR-7h)', async () => {
    mockDeepResearch.mockRejectedValueOnce(new Error('deep_research exceeded ceiling'));
    const result = await executeStandardTool('web_deep_research', { question: 'q' }, ctx);
    expect(result?.success).toBe(false);
    expect(result?.transient).toBeFalsy();
  });

  it('records TWO usage events (pre-charge + delta) with deterministic idempotency keys', async () => {
    const { usageLedgerService } = jest.requireMock('../../usage-ledger/service');
    mockDeepResearch.mockImplementationOnce(driveHappyPath(500_000));
    await executeStandardTool('web_deep_research', { question: 'q' }, ctx);

    // Two emissions — pre-charge first, delta second.
    expect(usageLedgerService.recordUsage).toHaveBeenCalledTimes(2);

    const [preCharge, delta] = usageLedgerService.recordUsage.mock.calls.map(
      (c: unknown[]) => c[0] as Record<string, unknown>,
    );

    // Pre-charge: actionId == deep_research_id (D2.3); metadata carries
    // is_pre_charge:true + idempotency_key == deep_research_id.
    expect(preCharge.actionId).toBe(DEEP_RESEARCH_ID);
    expect(preCharge.eventType).toBe('web_deep_research');
    expect(preCharge.credits).toBe(1);
    const preMeta = preCharge.metadata as Record<string, unknown>;
    expect(preMeta.is_pre_charge).toBe(true);
    expect(preMeta.idempotency_key).toBe(DEEP_RESEARCH_ID);
    expect(preMeta.deep_research_id).toBe(DEEP_RESEARCH_ID);
    expect(preMeta.cost_micros).toBe(400_000);
    expect(preMeta.submission_id).toBe(SUBMISSION_ID);

    // Delta: actionId is a fresh UUID (NOT deep_research_id); credits=0;
    // metadata.idempotency_key == `${deep_research_id}/delta`; cost_micros
    // is the SIGNED delta (actual − estimate).
    expect(delta.actionId).not.toBe(DEEP_RESEARCH_ID);
    expect(typeof delta.actionId).toBe('string');
    expect(delta.eventType).toBe('web_deep_research');
    expect(delta.credits).toBe(0);
    const deltaMeta = delta.metadata as Record<string, unknown>;
    expect(deltaMeta.is_delta).toBe(true);
    expect(deltaMeta.idempotency_key).toBe(`${DEEP_RESEARCH_ID}/delta`);
    expect(deltaMeta.cost_micros).toBe(100_000);   // 500k − 400k
    expect(deltaMeta.estimate_cost_micros).toBe(400_000);
    expect(deltaMeta.actual_cost_micros).toBe(500_000);
    expect(deltaMeta.final_status).toBe('COMPLETED');
  });

  it('delta event carries NEGATIVE cost_micros when actual < estimate (over-estimate true-up)', async () => {
    const { usageLedgerService } = jest.requireMock('../../usage-ledger/service');
    mockDeepResearch.mockImplementationOnce(driveHappyPath(100_000));   // actual cheaper than estimate
    await executeStandardTool('web_deep_research', { question: 'q' }, ctx);

    const delta = usageLedgerService.recordUsage.mock.calls[1][0] as Record<string, unknown>;
    const deltaMeta = delta.metadata as Record<string, unknown>;
    expect(deltaMeta.cost_micros).toBe(-300_000);   // 100k − 400k
  });

  it('publishes pre-charge + delta to the web-tool Pub/Sub topic with matching idempotency keys (Phase 4 push path)', async () => {
    mockDeepResearch.mockImplementationOnce(driveHappyPath(500_000));
    await executeStandardTool('web_deep_research', { question: 'q' }, ctx);

    expect(mockPublishWebToolEvent).toHaveBeenCalledTimes(2);
    const [preCharge, delta] = mockPublishWebToolEvent.mock.calls.map(
      (c: unknown[]) => c[0] as Record<string, unknown>,
    );

    expect(preCharge.idempotencyKey).toBe(DEEP_RESEARCH_ID);
    expect(preCharge.eventType).toBe('web_deep_research');
    expect(preCharge.costUsd).toBeCloseTo(0.40);    // estimate / 1e6
    expect((preCharge.metadata as Record<string, unknown>).is_pre_charge).toBe(true);

    expect(delta.idempotencyKey).toBe(`${DEEP_RESEARCH_ID}/delta`);
    expect(delta.eventType).toBe('web_deep_research');
    expect(delta.costUsd).toBeCloseTo(0.10);        // (500k − 400k) / 1e6 — SIGNED
    expect((delta.metadata as Record<string, unknown>).is_delta).toBe(true);
    expect((delta.metadata as Record<string, unknown>).final_status).toBe('COMPLETED');
  });

  it('validates reasoning_effort enum and rejects out-of-range', async () => {
    const result = await executeStandardTool('web_deep_research', { question: 'q', reasoning_effort: 'extreme' }, ctx);
    expect(result?.success).toBe(false);
    expect(result?.error).toMatch(/reasoning_effort/);
  });

  it('rejects reasoning_effort=medium (Google Deep Research not yet GA on GCP)', async () => {
    const result = await executeStandardTool('web_deep_research', { question: 'q', reasoning_effort: 'medium' }, ctx);
    expect(result?.success).toBe(false);
    expect(result?.error).toMatch(/reasoning_effort must be one of: low, high/);
  });

  it('rejects reasoning_effort=highest (Google Deep Research Max not yet GA on GCP)', async () => {
    const result = await executeStandardTool('web_deep_research', { question: 'q', reasoning_effort: 'highest' }, ctx);
    expect(result?.success).toBe(false);
    expect(result?.error).toMatch(/reasoning_effort must be one of: low, high/);
  });

  it('accepts reasoning_effort=low', async () => {
    mockDeepResearch.mockImplementationOnce(driveHappyPath());
    const result = await executeStandardTool('web_deep_research', { question: 'q', reasoning_effort: 'low' }, ctx);
    expect(result?.success).toBe(true);
  });

  it('accepts reasoning_effort=high', async () => {
    mockDeepResearch.mockImplementationOnce(driveHappyPath());
    const result = await executeStandardTool('web_deep_research', { question: 'q', reasoning_effort: 'high' }, ctx);
    expect(result?.success).toBe(true);
  });

  it('validates question is a non-empty string', async () => {
    const result = await executeStandardTool('web_deep_research', {}, ctx);
    expect(result?.success).toBe(false);
    expect(result?.error).toMatch(/question/);
  });

  describe('outbox fallback (Gap #1)', () => {
    function driveHappyPathWithVendor(actualCostMicros: number = 500_000) {
      return async (
        _req: unknown,
        _ctx: unknown,
        hooks: {
          onPreCharge?: (p: unknown) => Promise<void>;
          onCompletion?: (d: unknown) => Promise<void>;
        },
      ) => {
        const estimateCostMicros = 400_000;
        await hooks.onPreCharge?.({
          deepResearchId:    DEEP_RESEARCH_ID,
          vendor:            'perplexity',
          reasoningEffort:   'medium',
          estimateCostMicros,
          submittedAt:       new Date('2026-06-02T00:00:00Z'),
          submissionId:      SUBMISSION_ID,
        });
        await hooks.onCompletion?.({
          deepResearchId:    DEEP_RESEARCH_ID,
          vendor:            'perplexity',
          actualCostMicros,
          estimateCostMicros,
          deltaCostMicros:   actualCostMicros - estimateCostMicros,
          status:            'COMPLETED',
          submissionId:      SUBMISSION_ID,
        });
        return { ...COMPLETED, costMicros: actualCostMicros };
      };
    }

    it('enqueues pre_charge to outbox when publish returns false', async () => {
      mockPublishWebToolEvent
        .mockResolvedValueOnce(false)  // pre-charge fails
        .mockResolvedValueOnce(true);  // delta succeeds
      mockDeepResearch.mockImplementationOnce(driveHappyPathWithVendor());
      await executeStandardTool('web_deep_research', { question: 'q' }, ctx);
      const enqueueArgs = mockEnqueueOutbox.mock.calls.find(c => c[1] === 'pre_charge');
      expect(enqueueArgs).toBeDefined();
      expect(enqueueArgs?.[0]).toBe(DEEP_RESEARCH_ID);
      expect(enqueueArgs?.[3]).toBe('publish returned false');
    });

    it('enqueues delta to outbox when publish returns false on completion', async () => {
      mockPublishWebToolEvent
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      mockDeepResearch.mockImplementationOnce(driveHappyPathWithVendor());
      await executeStandardTool('web_deep_research', { question: 'q' }, ctx);
      const enqueueArgs = mockEnqueueOutbox.mock.calls.find(c => c[1] === 'delta');
      expect(enqueueArgs).toBeDefined();
      expect(enqueueArgs?.[0]).toBe(DEEP_RESEARCH_ID);
    });

    it('does not enqueue on successful publish', async () => {
      mockPublishWebToolEvent.mockResolvedValue(true);
      mockDeepResearch.mockImplementationOnce(driveHappyPathWithVendor());
      await executeStandardTool('web_deep_research', { question: 'q' }, ctx);
      expect(mockEnqueueOutbox).not.toHaveBeenCalled();
    });
  });
});

describe('web_fetch_advanced — profile reuse stamps last_used_at', () => {
  it('updates web_profiles.last_used_at when a saved profile is reused on the stateful path', async () => {
    // The profile SELECT returns a row; everything else (takeover check, the
    // last_used_at UPDATE, audit) returns empty. resolveProfileAndIdentity
    // fires the UPDATE before the router runs, so it's recorded regardless of
    // the fetch outcome.
    mockPoolQuery.mockImplementation((sql: string) => {
      if (/SELECT vendor_profile_id FROM web_profiles/.test(sql)) {
        return Promise.resolve({ rows: [{ vendor_profile_id: 'salesforce-acme' }] });
      }
      return Promise.resolve({ rows: [] });
    });
    mockFetch.mockResolvedValue({
      content: 'ok', finalUrl: 'https://example.com', vendor: 'anchor',
      costMicros: 0, jsRendered: true, sessionId: 'sess-1',
    });

    await executeStandardTool(
      'web_fetch_advanced',
      { url: 'https://example.com', session_id: 'sess-1', profile: 'salesforce-acme' },
      ctx,
    );

    const update = mockPoolQuery.mock.calls.find(c => /UPDATE web_profiles SET last_used_at/.test(c[0] as string));
    expect(update).toBeTruthy();
    expect(update![1]).toEqual(['tenant-1', 'salesforce-acme']);
  });
});

// A page that cannot be retrieved is reported as that: `not_found`,
// non-retryable, naming the address, with recovery text that tells the model
// what it may conclude (nothing) and what to do instead. Anything else the
// router throws keeps today's `Failed to fetch URL.`.
describe('web_fetch_advanced — a missing page is not a broken tool', () => {
  // The class lives beside the miss rule (origin-miss.ts), which this file
  // does not mock, so the handler's `instanceof` sees the same class.
  const { PageUnretrievable } = jest.requireActual('../../integrations/web-fetch/origin-miss') as typeof import('../../integrations/web-fetch/origin-miss');
  const { ExaError } = jest.requireActual('../../integrations/web-fetch/exa-client') as typeof import('../../integrations/web-fetch/exa-client');

  it('turns PageUnretrievable into not_found, naming the URL, not retryable', async () => {
    mockFetch.mockRejectedValue(new PageUnretrievable('https://example.com/blog?token=abc', [
      { vendor: 'exa', reason: 'Empty content from Exa /contents' },
      { vendor: 'tavily', reason: 'Tavily /extract failed: 404 page not found' },
    ]));
    const result = await executeStandardTool('web_fetch_advanced', { url: 'https://example.com/blog?token=abc' }, ctx);
    expect(result?.success).toBe(false);
    expect(result?.errorCode).toBe('not_found');
    expect(result?.retryable).toBe(false);
    expect(result?.error).toContain('https://example.com/blog?token=%5BREDACTED%5D');
    expect(result?.error).toContain('Empty content from Exa /contents');
    expect(result?.error).not.toContain('token=abc');
    expect(result?.recovery).toBe(
      'The page does not exist at this address or will not serve automated readers. '
      + 'Do not infer anything for it; use another address or say the page could not be read.',
    );
  });

  it('keeps today\'s generic failure for a vendor 5xx', async () => {
    mockFetch.mockRejectedValue(new ExaError('upstream unavailable', 503));
    const result = await executeStandardTool('web_fetch_advanced', { url: 'https://example.com' }, ctx);
    expect(result?.success).toBe(false);
    expect(result?.error).toBe('Failed to fetch URL.');
    expect(result?.errorCode).toBeUndefined();
  });
});
