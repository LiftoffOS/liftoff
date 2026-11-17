const mockGetSecret = jest.fn();
jest.mock('../../../infrastructure/secrets', () => ({
  getSecret: (...a: unknown[]) => mockGetSecret(...a),
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockInsertSubmission   = jest.fn();
const mockFinalizeSubmission = jest.fn();
const mockMarkPolled         = jest.fn();
const mockMarkHookActive     = jest.fn();

jest.mock('../deep-research-registry', () => ({
  insertSubmission:   (...a: unknown[]) => mockInsertSubmission(...a),
  finalizeSubmission: (...a: unknown[]) => mockFinalizeSubmission(...a),
  markPolled:         (...a: unknown[]) => mockMarkPolled(...a),
  markHookActive:     (...a: unknown[]) => mockMarkHookActive(...a),
}));

import { PerplexityClient, PerplexityError, isFetchUrlNoResult } from '../perplexity-client';

const originalFetch = global.fetch;
afterAll(() => { global.fetch = originalFetch; });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSecret.mockResolvedValue('api-key');
});

/** A response carries HEADERS, and the client reads them on a failure: the
 *  vendor states its retry-after there on every 429 and the client used to
 *  throw it away with the rest. A mock without them is not a Response, and the
 *  absence surfaced as a TypeError rather than as a missing field. */
function mockFetchOnce(status: number, body: unknown, headers: Record<string, string> = {}) {
  global.fetch = jest.fn().mockResolvedValueOnce({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? 'Unauthorized' : status === 429 ? 'Too Many Requests' : 'Error',
    headers: new Headers(headers),
    json: async () => body,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  }) as unknown as typeof fetch;
}

function mockFetchSequence(...responses: Array<{ status: number; body: unknown }>) {
  const fn = jest.fn();
  for (const r of responses) {
    fn.mockResolvedValueOnce({
      ok: r.status >= 200 && r.status < 300,
      status: r.status,
      statusText: 'OK',
      headers: new Headers(),
      json: async () => r.body,
      text: async () => (typeof r.body === 'string' ? r.body : JSON.stringify(r.body)),
    });
  }
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

// Shape an /v1/agent response with the required usage.cost.total_cost field.
// Tests that omit cost on purpose use rawAgentResponse() to verify the 422 throw.
const agentResponse = (items: unknown[], totalCostUsd: number = 0.0005) => ({
  output: items,
  usage: { cost: { currency: 'USD', total_cost: totalCostUsd } },
});
const rawAgentResponse = (items: unknown[], extra: Record<string, unknown> = {}) => ({
  output: items,
  ...extra,
});

describe('PerplexityClient.fetch', () => {
  it('returns content + flat vendor + exact costMicros from usage.cost.total_cost', async () => {
    mockFetchOnce(200, agentResponse([
      { type: 'fetch_url_results', contents: [{ url: 'https://x', snippet: '# hi' }] },
    ], 0.0005));
    const c = new PerplexityClient();
    const out = await c.fetch({ url: 'https://x' });
    expect(out.content).toBe('# hi');
    expect(out.vendor).toBe('perplexity');
    expect(out.costMicros).toBe(500);  // 0.0005 USD → 500 micros (exact, not approximated)
    expect(out.jsRendered).toBe(false);
    expect(out.finalUrl).toBe('https://x');
  });

  it('reflects a higher actual cost when LLM token usage drives total_cost up', async () => {
    // Real fetch may cost more than the $0.0005 tool floor when the LLM step
    // expands the response. The handler must record that exact billed amount.
    mockFetchOnce(200, agentResponse([
      { type: 'fetch_url_results', contents: [{ url: 'https://x', snippet: 'hi' }] },
    ], 0.00075));
    const c = new PerplexityClient();
    const out = await c.fetch({ url: 'https://x' });
    expect(out.costMicros).toBe(750);
  });

  it('throws PerplexityError(422) when response is missing usage.cost.total_cost (OU billing safeguard)', async () => {
    mockFetchOnce(200, rawAgentResponse([
      { type: 'fetch_url_results', contents: [{ url: 'https://x', snippet: 'hi' }] },
    ]));
    const c = new PerplexityClient();
    const err = await c.fetch({ url: 'https://x' }).catch(e => e);
    expect(err).toBeInstanceOf(PerplexityError);
    expect((err as PerplexityError).statusCode).toBe(422);
    expect((err as PerplexityError).message).toMatch(/usage\.cost\.total_cost/);
  });

  it('throws PerplexityError(422) when total_cost is non-numeric (defensive against shape drift)', async () => {
    mockFetchOnce(200, rawAgentResponse(
      [{ type: 'fetch_url_results', contents: [{ url: 'https://x', snippet: 'hi' }] }],
      { usage: { cost: { currency: 'USD', total_cost: 'oops' } } },
    ));
    const c = new PerplexityClient();
    const err = await c.fetch({ url: 'https://x' }).catch(e => e);
    expect(err).toBeInstanceOf(PerplexityError);
    expect((err as PerplexityError).statusCode).toBe(422);
  });

  it('throws PerplexityError(422) when total_cost is negative (defensive against vendor bug)', async () => {
    mockFetchOnce(200, rawAgentResponse(
      [{ type: 'fetch_url_results', contents: [{ url: 'https://x', snippet: 'hi' }] }],
      { usage: { cost: { currency: 'USD', total_cost: -0.01 } } },
    ));
    const c = new PerplexityClient();
    const err = await c.fetch({ url: 'https://x' }).catch(e => e);
    expect(err).toBeInstanceOf(PerplexityError);
    expect((err as PerplexityError).statusCode).toBe(422);
    expect((err as PerplexityError).message).toMatch(/negative/);
  });

  it('throws PerplexityError(422) when currency is not USD (OU conversion assumes USD)', async () => {
    mockFetchOnce(200, rawAgentResponse(
      [{ type: 'fetch_url_results', contents: [{ url: 'https://x', snippet: 'hi' }] }],
      { usage: { cost: { currency: 'EUR', total_cost: 0.0005 } } },
    ));
    const c = new PerplexityClient();
    const err = await c.fetch({ url: 'https://x' }).catch(e => e);
    expect(err).toBeInstanceOf(PerplexityError);
    expect((err as PerplexityError).statusCode).toBe(422);
    expect((err as PerplexityError).message).toMatch(/non-USD/);
  });

  it('accepts zero total_cost (legitimate cache hit / free-tier call)', async () => {
    mockFetchOnce(200, agentResponse([
      { type: 'fetch_url_results', contents: [{ url: 'https://x', snippet: 'hi' }] },
    ], 0));
    const c = new PerplexityClient();
    const out = await c.fetch({ url: 'https://x' });
    expect(out.costMicros).toBe(0);
  });

  it('throws PerplexityError on 401', async () => {
    mockFetchOnce(401, { error: 'bad key' });
    const c = new PerplexityClient();
    await expect(c.fetch({ url: 'https://x' })).rejects.toBeInstanceOf(PerplexityError);
  });

  it('carries the retry-after the vendor stated on a 429', async () => {
    // The Agent API sends `retry-after: 1` with every rate refusal. It reached
    // no reader, so a one-second wait was reported to the model as a permanent
    // internal error on twelve consecutive calls in one live run.
    mockFetchOnce(429, { error: { code: 429, type: 'request_rate_limit_exceeded' } }, { 'retry-after': '1' });
    const c = new PerplexityClient();
    await expect(c.fetch({ url: 'https://x' })).rejects.toMatchObject({
      statusCode: 429,
      retryAfterMs: 1_000,
    });
  });

  it('leaves retry-after unset when the response stated none', async () => {
    mockFetchOnce(429, { error: { code: 429 } });
    const c = new PerplexityClient();
    await expect(c.fetch({ url: 'https://x' })).rejects.toMatchObject({ retryAfterMs: undefined });
  });

  it('throws PerplexityError(429) on rate-limit overflow', async () => {
    mockFetchOnce(429, { error: 'rate limited' });
    const c = new PerplexityClient();
    const err = await c.fetch({ url: 'https://x' }).catch(e => e);
    expect(err).toBeInstanceOf(PerplexityError);
    expect((err as PerplexityError).statusCode).toBe(429);
  });

  it('throws "Empty content" when body is blank (antibot guard) — before cost extraction', async () => {
    mockFetchOnce(200, agentResponse([
      { type: 'fetch_url_results', contents: [{ url: 'https://x', snippet: '' }] },
    ], 0.0005));
    const c = new PerplexityClient();
    await expect(c.fetch({ url: 'https://x' })).rejects.toThrow(/Empty content/);
  });

  // The vendor's other empty answer. For an origin that returns nothing (a
  // real 404) fetch_url hands back a bracketed placeholder naming its own
  // `no_result_returned` outcome instead of an empty snippet; read as content
  // it becomes the "page" the model sees and the call a success.
  it('throws at status 200 when fetch_url answers with its no_result_returned placeholder', async () => {
    mockFetchOnce(200, agentResponse([
      { type: 'fetch_url_results', contents: [{ url: 'https://x/missing', snippet:
        '[fetch_url: no content could be retrieved for https://x/missing — no_result_returned. The content service returned no result for this URL. Do not infer values for this source; try another source or state that the data could not be retrieved.]' }] },
    ], 0.0005));
    const c = new PerplexityClient();
    const err = await c.fetch({ url: 'https://x/missing' }).catch(e => e);
    expect(err).toBeInstanceOf(PerplexityError);
    expect((err as PerplexityError).statusCode).toBe(200);
    expect((err as PerplexityError).message).toMatch(/no_result_returned/);
    // The same shape the miss classifier reads (origin-miss.ts).
    expect(isFetchUrlNoResult('[fetch_url: no content could be retrieved for https://x — no_result_returned.]')).toBe(true);
    // A page that merely MENTIONS the code is a page.
    expect(isFetchUrlNoResult('The API returns no_result_returned when the fetch_url tool has nothing.')).toBe(false);
  });

  it('throws "Empty content" when fetch_url_results item is missing', async () => {
    mockFetchOnce(200, agentResponse([{ type: 'message', content: 'I refused.' }], 0.0005));
    const c = new PerplexityClient();
    await expect(c.fetch({ url: 'https://x' })).rejects.toThrow(/Empty content/);
  });

  it('rejects requests with sessionId', async () => {
    const c = new PerplexityClient();
    await expect(c.fetch({ url: 'https://x', sessionId: 's1' }))
      .rejects.toThrow(/Perplexity does not support sessions/);
  });

  it('targets POST /v1/agent with fetch_url tool', async () => {
    const fn = mockFetchSequence({ status: 200, body: agentResponse([
      { type: 'fetch_url_results', contents: [{ url: 'https://x', snippet: 'c' }] },
    ], 0.0005) });
    const c = new PerplexityClient();
    await c.fetch({ url: 'https://x' });
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.perplexity.ai/v1/agent');
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body as string);
    expect(body.tools).toEqual([{ type: 'fetch_url', max_urls: 1 }]);
  });
});

// The BASIC search. Ranked results at the Search API's flat contract price,
// no synthesis — what `web_search` runs on for every family without a search
// of its own.
describe('PerplexityClient.search', () => {
  it('returns ranked results with the Search-API flat contract cost ($0.005)', async () => {
    // /search returns NO cost field. USD_PER_SEARCH_REQUEST=0.005 is the
    // exact public contract price, not an approximation.
    mockFetchOnce(200, { results: [{ url: 'https://a', title: 'A', snippet: 'snip', date: '2026-09-01' }] });
    const c = new PerplexityClient();
    const out = await c.search({ query: 'q' });
    expect(out.results).toEqual([{ url: 'https://a', title: 'A', snippet: 'snip', date: '2026-09-01' }]);
    expect(out.vendor).toBe('perplexity');
    expect(out.costMicros).toBe(5_000);
    expect(out.summary).toBeUndefined();
  });

  it('targets POST /search with query + max_results capped at 20', async () => {
    const fn = mockFetchSequence({ status: 200, body: { results: [] } });
    const c = new PerplexityClient();
    await c.search({ query: 'q', maxResults: 100 });
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.perplexity.ai/search');
    const body = JSON.parse(init.body as string);
    expect(body.max_results).toBe(20);
    expect(body.query).toBe('q');
  });
});

// The ADVANCED tier. `web_research` used to run on /search too — ranked
// snippets under a description that promised a synthesized, cited answer —
// so this is the Agent API's own web_search now: sources read, one answer
// written, exact cost from the response.
describe('PerplexityClient.research', () => {
  it('returns a synthesized answer with the sources the agent read, at the exact billed cost', async () => {
    mockFetchOnce(200, agentResponse([
      { type: 'search_results', queries: ['q'], results: [
        { id: 1, url: 'https://a', title: 'A', snippet: 'about a' },
        { id: 2, url: 'https://b', title: 'B' },
        { id: 3, url: 'https://a', title: 'A again' },
      ] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'A and B agree that…' }] },
    ], 0.0031));
    const c = new PerplexityClient();
    const out = await c.research({ question: 'q' });
    expect(out.answer).toBe('A and B agree that…');
    expect(out.sources).toEqual([
      { url: 'https://a', title: 'A', snippet: 'about a' },
      { url: 'https://b', title: 'B', snippet: undefined },
    ]);
    expect(out.vendor).toBe('perplexity');
    expect(out.costMicros).toBe(3_100);
  });

  it('reads a message whose content is a plain string, the shape the live API answered with', async () => {
    mockFetchOnce(200, agentResponse([{ type: 'message', content: 'plain' }], 0.001));
    const out = await new PerplexityClient().research({ question: 'q' });
    expect(out.answer).toBe('plain');
    expect(out.sources).toEqual([]);
  });

  it('targets POST /v1/agent with the web_search tool, never /search', async () => {
    const fn = mockFetchSequence({ status: 200, body: agentResponse([{ type: 'message', content: 'x' }]) });
    const c = new PerplexityClient();
    await c.research({ question: 'q', maxSources: 100 });
    const [url, init] = fn.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.perplexity.ai/v1/agent');
    const body = JSON.parse(init.body as string);
    expect(body.tools).toEqual([{ type: 'web_search', max_results: 50 }]);
    expect(body.input).toContain('q');
  });

  it('parses the answer as JSON when an output schema was asked for', async () => {
    mockFetchOnce(200, agentResponse([{ type: 'message', content: '{"answer": 42}' }]));
    const out = await new PerplexityClient().research({ question: 'q', outputSchema: { type: 'object' } });
    expect(out.answer).toEqual({ answer: 42 });
  });

  it('throws PerplexityError(422) when the response omits usage.cost.total_cost', async () => {
    mockFetchOnce(200, rawAgentResponse([{ type: 'message', content: 'x' }]));
    await expect(new PerplexityClient().research({ question: 'q' })).rejects.toThrow(PerplexityError);
  });
});

describe('PerplexityClient.peopleSearch', () => {
  it('returns structured results with flat vendor + exact costMicros from usage.cost.total_cost', async () => {
    mockFetchOnce(200, agentResponse([
      { type: 'people_search_results', results: [
        { title: 'A | CEO @ X', url: 'https://a', snippet: '**A**\nCEO\nAcme Corp' },
      ] },
    ], 0.012));
    const c = new PerplexityClient();
    const out = await c.peopleSearch({ query: 'alice' });
    expect(out.results).toHaveLength(1);
    expect(out.results[0].name).toBe('A | CEO @ X');   // mapped from p.title
    expect(out.results[0].title).toBe('**A**\nCEO\nAcme Corp');  // mapped from p.snippet
    expect(out.results[0].sources).toEqual(['https://a']);       // mapped from [p.url]
    expect(out.vendor).toBe('perplexity');
    expect(out.costMicros).toBe(12_000);  // 0.012 USD = 12000 micros
  });

  it('throws PerplexityError(422) when peopleSearch response omits usage.cost.total_cost', async () => {
    mockFetchOnce(200, rawAgentResponse([
      { type: 'people_search_results', results: [] },
    ]));
    const c = new PerplexityClient();
    const err = await c.peopleSearch({ query: 'alice' }).catch(e => e);
    expect(err).toBeInstanceOf(PerplexityError);
    expect((err as PerplexityError).statusCode).toBe(422);
  });

  it('passes through filters (company/title/location) into the agent input prompt', async () => {
    const fn = mockFetchSequence({ status: 200, body: agentResponse([
      { type: 'people_search_results', results: [] },
    ], 0.005) });
    const c = new PerplexityClient();
    await c.peopleSearch({ query: 'alice', filters: { company: 'X', title: 'CEO', location: 'NY' } });
    const callBody = JSON.parse((fn.mock.calls[0][1] as RequestInit).body as string);
    expect(callBody.input).toMatch(/company=X/);
    expect(callBody.input).toMatch(/title=CEO/);
    expect(callBody.input).toMatch(/location=NY/);
    expect(callBody.tools).toEqual([{ type: 'people_search' }]);
  });

  it('embeds max sources in the agent input prompt (no max_results field on Agent API)', async () => {
    const fn = mockFetchSequence({ status: 200, body: agentResponse([
      { type: 'people_search_results', results: [] },
    ], 0.005) });
    const c = new PerplexityClient();
    await c.peopleSearch({ query: 'alice', maxSources: 15 });
    const callBody = JSON.parse((fn.mock.calls[0][1] as RequestInit).body as string);
    expect(callBody.input).toMatch(/up to 15 people/);
    expect(callBody.max_results).toBeUndefined();
  });

  it('wraps url into sources array (Perplexity returns a single url per result)', async () => {
    mockFetchOnce(200, agentResponse([
      { type: 'people_search_results', results: [
        { title: 'B', url: 'https://b' },
      ] },
    ], 0.005));
    const c = new PerplexityClient();
    const out = await c.peopleSearch({ query: 'b' });
    expect(out.results[0].sources).toEqual(['https://b']);
  });
});

describe('PerplexityClient.financeSearch', () => {
  it('returns structured results with flat vendor + exact costMicros from usage.cost.total_cost', async () => {
    mockFetchOnce(200, agentResponse([
      { type: 'finance_results', results: [
        { category: 'quote', content: '## AAPL Quote\n| AAPL | $306 |', sources: ['https://a'], tickers: ['AAPL'] },
      ] },
    ], 0.015));
    const c = new PerplexityClient();
    const out = await c.financeSearch({ query: 'AAPL' });
    expect(out.results).toHaveLength(1);
    expect(out.results[0].ticker).toBe('AAPL');        // mapped from f.tickers[0]
    expect(out.results[0].instrument).toBe('quote');    // mapped from f.category
    expect(out.results[0].summary).toContain('AAPL');   // mapped from f.content
    expect(out.results[0].sources).toEqual(['https://a']);
    expect(out.vendor).toBe('perplexity');
    expect(out.costMicros).toBe(15_000);
  });

  it('throws PerplexityError(422) when financeSearch response omits usage.cost.total_cost', async () => {
    mockFetchOnce(200, rawAgentResponse([
      { type: 'finance_results', results: [] },
    ]));
    const c = new PerplexityClient();
    const err = await c.financeSearch({ query: 'q' }).catch(e => e);
    expect(err).toBeInstanceOf(PerplexityError);
    expect((err as PerplexityError).statusCode).toBe(422);
  });

  it('passes through instrument into the agent input prompt', async () => {
    const fn = mockFetchSequence({ status: 200, body: agentResponse([
      { type: 'finance_results', results: [] },
    ], 0.005) });
    const c = new PerplexityClient();
    await c.financeSearch({ query: 'q', instrument: 'AAPL' });
    const callBody = JSON.parse((fn.mock.calls[0][1] as RequestInit).body as string);
    expect(callBody.input).toMatch(/Instrument: AAPL/);
    expect(callBody.tools).toEqual([{ type: 'finance_search' }]);
  });
});

describe('PerplexityClient.deepResearch', () => {
  // The client's DEEP_RESEARCH_POLL_INTERVAL_MS is 5000ms. Jest's default per-
  // test timeout is also 5000ms, so the real sleep would race the test runner.
  // Stub setTimeout to fire immediately so each happy-path test takes <1s.
  let setTimeoutSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.useRealTimers();
    setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
      Promise.resolve().then(fn);
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);
  });
  afterEach(() => { setTimeoutSpy.mockRestore(); });

  const completedBody = (totalCostUsd: number, extra: Partial<{ search_results: unknown[]; usage: Record<string, unknown> }> = {}) => ({
    status: 'COMPLETED',
    response: {
      choices: [{ message: { content: 'the report' } }],
      search_results: extra.search_results ?? [],
      usage: {
        prompt_tokens: 100, completion_tokens: 200, citation_tokens: 0, reasoning_tokens: 50, num_search_queries: 3,
        ...(extra.usage ?? {}),
        cost: { currency: 'USD', total_cost: totalCostUsd },
      },
    },
  });

  it('submits to /async/chat/completions with reasoning_effort=medium and request wrapper', async () => {
    const fn = mockFetchSequence(
      { status: 200, body: { id: 'task-1' } },
      { status: 200, body: completedBody(0.5) },
    );
    const c = new PerplexityClient();
    await c.deepResearch({ question: 'q', maxWaitMs: 30_000 });
    const [submitUrl, submitInit] = fn.mock.calls[0] as [string, RequestInit];
    expect(submitUrl).toBe('https://api.perplexity.ai/async/chat/completions');
    const submitBody = JSON.parse(submitInit.body as string);
    expect(submitBody.request.reasoning_effort).toBe('medium');
    expect(submitBody.request.model).toBe('sonar-deep-research');
    expect(submitBody.request.messages[0]).toEqual({ role: 'user', content: 'q' });
  });

  it('polls GET /async/chat/completions/{id} for status — POST body, GET no body', async () => {
    const fn = mockFetchSequence(
      { status: 200, body: { id: 'task-2' } },
      { status: 200, body: completedBody(0.5) },
    );
    const c = new PerplexityClient();
    await c.deepResearch({ question: 'q', maxWaitMs: 30_000 });
    const [pollUrl, pollInit] = fn.mock.calls[1] as [string, RequestInit];
    expect(pollUrl).toBe('https://api.perplexity.ai/async/chat/completions/task-2');
    expect(pollInit.method).toBe('GET');
    expect(pollInit.body).toBeUndefined();
    expect((fn.mock.calls[0][1] as RequestInit).body).toBeDefined();
  });

  it('honors reasoning_effort override (low / high)', async () => {
    const fn = mockFetchSequence(
      { status: 200, body: { id: 'task-3' } },
      { status: 200, body: completedBody(0.5) },
    );
    const c = new PerplexityClient();
    await c.deepResearch({ question: 'q', reasoningEffort: 'high', maxWaitMs: 30_000 });
    const submitCall = JSON.parse((fn.mock.calls[0][1] as RequestInit).body as string);
    expect(submitCall.request.reasoning_effort).toBe('high');
  });

  it('extracts exact costMicros from response usage.cost.total_cost (NOT computed from token counts)', async () => {
    // Hand-computed token math would give a wildly different number — we must
    // use the billed amount the server tells us, not our own estimate.
    mockFetchSequence(
      { status: 200, body: { id: 'task-4' } },
      { status: 200, body: completedBody(0.42, {
        search_results: [{ url: 'https://a', title: 'A' }],
        usage: { prompt_tokens: 10_000, completion_tokens: 5_000, reasoning_tokens: 50_000, citation_tokens: 1_000, num_search_queries: 8 },
      }) },
    );
    const c = new PerplexityClient();
    const out = await c.deepResearch({ question: 'q', maxWaitMs: 30_000 });
    expect(out.report).toBe('the report');
    expect(out.vendor).toBe('perplexity');
    expect(out.sources).toHaveLength(1);
    expect(out.durationMs).toBeGreaterThanOrEqual(0);
    // Token counts are preserved as descriptive metadata — but cost is the
    // exact billed amount, 0.42 USD = 420_000 micros.
    expect(out.usage.prompt_tokens).toBe(10_000);
    expect(out.usage.reasoning_tokens).toBe(50_000);
    expect(out.usage.num_search_queries).toBe(8);
    expect(out.costMicros).toBe(420_000);
  });

  it('throws PerplexityError(422) when deep_research response omits usage.cost.total_cost', async () => {
    mockFetchSequence(
      { status: 200, body: { id: 'task-5' } },
      { status: 200, body: {
        status: 'COMPLETED',
        response: {
          choices: [{ message: { content: 'r' } }],
          usage: { prompt_tokens: 0, completion_tokens: 0 },  // no cost field
        },
      } },
    );
    const c = new PerplexityClient();
    const err = await c.deepResearch({ question: 'q', maxWaitMs: 30_000 }).catch(e => e);
    expect(err).toBeInstanceOf(PerplexityError);
    expect((err as PerplexityError).statusCode).toBe(422);
  });

  it('throws PerplexityError(500) on status=FAILED, surfacing error_message', async () => {
    mockFetchSequence(
      { status: 200, body: { id: 'task-6' } },
      { status: 200, body: { status: 'FAILED', error_message: 'upstream', response: null } },
    );
    const c = new PerplexityClient();
    const err = await c.deepResearch({ question: 'q', maxWaitMs: 30_000 }).catch(e => e);
    expect(err).toBeInstanceOf(PerplexityError);
    expect((err as PerplexityError).statusCode).toBe(500);
    expect((err as PerplexityError).message).toContain('upstream');
  });

  it('throws PerplexityError(408) — NOT (0) — after maxWaitMs without COMPLETED (TR-7h sentinel)', async () => {
    const fn = jest.fn();
    fn.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 'task-7' }), text: async () => '' });
    fn.mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'IN_PROGRESS' }), text: async () => '' });
    global.fetch = fn as unknown as typeof fetch;
    const c = new PerplexityClient();
    const err = await c.deepResearch({ question: 'q', maxWaitMs: 1 }).catch(e => e);
    expect(err).toBeInstanceOf(PerplexityError);
    expect((err as PerplexityError).statusCode).toBe(408);
  });

  it('honors maxWaitMs override (default ceiling not used when override is smaller)', async () => {
    const fn = jest.fn();
    fn.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 'task-8' }), text: async () => '' });
    fn.mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'IN_PROGRESS' }), text: async () => '' });
    global.fetch = fn as unknown as typeof fetch;
    const c = new PerplexityClient();
    const t0 = Date.now();
    await c.deepResearch({ question: 'q', maxWaitMs: 1 }).catch(() => {});
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeLessThan(30_000);
  });
});

// Phase 1 + Phase 2 of the deep-research-realtime-billing plan: hooks
// (onHeartbeat / onPreCharge / onCompletion). Phase 4: post-publish
// assertions live in the deep-research-publisher describe further down.
describe('PerplexityClient.deepResearch — hooks', () => {
  let setTimeoutSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.useRealTimers();
    setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
      Promise.resolve().then(fn);
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);
  });
  afterEach(() => { setTimeoutSpy.mockRestore(); });

  const completedBody = (totalCostUsd: number) => ({
    status: 'COMPLETED',
    response: {
      choices: [{ message: { content: 'the report' } }],
      search_results: [],
      usage: {
        prompt_tokens: 100, completion_tokens: 200, citation_tokens: 0,
        reasoning_tokens: 50, num_search_queries: 3,
        cost: { currency: 'USD', total_cost: totalCostUsd },
      },
    },
  });

  it('fires onPreCharge IMMEDIATELY after submit, with default $0.40 estimate for reasoning_effort=medium', async () => {
    mockFetchSequence(
      { status: 200, body: { id: 'task-pre-1' } },
      { status: 200, body: completedBody(0.5) },
    );
    const c = new PerplexityClient();
    const onPreCharge = jest.fn().mockResolvedValue(undefined);
    await c.deepResearch({ question: 'q', maxWaitMs: 30_000 }, { onPreCharge });
    expect(onPreCharge).toHaveBeenCalledTimes(1);
    const arg = onPreCharge.mock.calls[0][0];
    expect(arg.reasoningEffort).toBe('medium');
    expect(arg.estimateCostMicros).toBe(400_000);   // 0.40 USD default
    expect(arg.submissionId).toBe('task-pre-1');
    expect(typeof arg.deepResearchId).toBe('string');
    expect(arg.deepResearchId.length).toBeGreaterThan(0);
    expect(arg.submittedAt).toBeInstanceOf(Date);
  });

  it('uses $0.15 estimate for reasoning_effort=low, $0.75 for high', async () => {
    mockFetchSequence(
      { status: 200, body: { id: 'task-pre-low' } },
      { status: 200, body: completedBody(0.5) },
      { status: 200, body: { id: 'task-pre-high' } },
      { status: 200, body: completedBody(0.5) },
    );
    const c = new PerplexityClient();
    const lowPre = jest.fn().mockResolvedValue(undefined);
    const highPre = jest.fn().mockResolvedValue(undefined);
    await c.deepResearch({ question: 'q', reasoningEffort: 'low',  maxWaitMs: 30_000 }, { onPreCharge: lowPre });
    await c.deepResearch({ question: 'q', reasoningEffort: 'high', maxWaitMs: 30_000 }, { onPreCharge: highPre });
    expect(lowPre.mock.calls[0][0].estimateCostMicros).toBe(150_000);
    expect(highPre.mock.calls[0][0].estimateCostMicros).toBe(750_000);
  });

  it('fires onCompletion with status=COMPLETED and signed delta (actual − estimate)', async () => {
    mockFetchSequence(
      { status: 200, body: { id: 'task-cmpl-1' } },
      { status: 200, body: completedBody(0.50) },   // actual = 0.50 USD
    );
    const c = new PerplexityClient();
    const onCompletion = jest.fn().mockResolvedValue(undefined);
    await c.deepResearch({ question: 'q', maxWaitMs: 30_000 }, { onCompletion });
    expect(onCompletion).toHaveBeenCalledTimes(1);
    const arg = onCompletion.mock.calls[0][0];
    expect(arg.status).toBe('COMPLETED');
    expect(arg.actualCostMicros).toBe(500_000);
    expect(arg.estimateCostMicros).toBe(400_000);
    expect(arg.deltaCostMicros).toBe(100_000);     // signed: 500k − 400k = +100k
    expect(arg.submissionId).toBe('task-cmpl-1');
  });

  it('fires onCompletion with NEGATIVE delta when actual < estimate (over-estimate refund)', async () => {
    mockFetchSequence(
      { status: 200, body: { id: 'task-cmpl-2' } },
      { status: 200, body: completedBody(0.10) },   // actual = 0.10 USD, estimate 0.40
    );
    const c = new PerplexityClient();
    const onCompletion = jest.fn().mockResolvedValue(undefined);
    await c.deepResearch({ question: 'q', maxWaitMs: 30_000 }, { onCompletion });
    expect(onCompletion.mock.calls[0][0].deltaCostMicros).toBe(-300_000);
  });

  it('fires onCompletion with status=FAILED and delta=-estimate (full refund), then throws', async () => {
    mockFetchSequence(
      { status: 200, body: { id: 'task-fail-1' } },
      { status: 200, body: { status: 'FAILED', error_message: 'upstream went bang', response: null } },
    );
    const c = new PerplexityClient();
    const onCompletion = jest.fn().mockResolvedValue(undefined);
    const err = await c.deepResearch({ question: 'q', maxWaitMs: 30_000 }, { onCompletion }).catch(e => e);
    expect(err).toBeInstanceOf(PerplexityError);
    expect(onCompletion).toHaveBeenCalledTimes(1);
    const arg = onCompletion.mock.calls[0][0];
    expect(arg.status).toBe('FAILED');
    expect(arg.actualCostMicros).toBe(0);
    expect(arg.deltaCostMicros).toBe(-400_000);    // full refund of $0.40 estimate
  });

  it('does NOT fire onCompletion on 408 ceiling (upstream still running, refund would create a billing hole)', async () => {
    const fn = jest.fn();
    fn.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 'task-408' }), text: async () => '' });
    fn.mockResolvedValue({ ok: true, status: 200, json: async () => ({ status: 'IN_PROGRESS' }), text: async () => '' });
    global.fetch = fn as unknown as typeof fetch;
    const c = new PerplexityClient();
    const onCompletion = jest.fn().mockResolvedValue(undefined);
    const err = await c.deepResearch({ question: 'q', maxWaitMs: 1 }, { onCompletion }).catch(e => e);
    expect(err).toBeInstanceOf(PerplexityError);
    expect((err as PerplexityError).statusCode).toBe(408);
    expect(onCompletion).not.toHaveBeenCalled();
  });

  it('precharge hook failure is fire-and-forget (does NOT abort the call)', async () => {
    mockFetchSequence(
      { status: 200, body: { id: 'task-pre-fail' } },
      { status: 200, body: completedBody(0.5) },
    );
    const c = new PerplexityClient();
    const onPreCharge = jest.fn().mockRejectedValue(new Error('db down'));
    const onCompletion = jest.fn().mockResolvedValue(undefined);
    // No throw expected — pre-charge failures must NOT fail the customer call.
    const out = await c.deepResearch({ question: 'q', maxWaitMs: 30_000 }, { onPreCharge, onCompletion });
    expect(out.report).toBe('the report');
    expect(onCompletion).toHaveBeenCalledTimes(1);
  });

  it('onHeartbeat is called when the simulated clock advances past HEARTBEAT_INTERVAL_MS', async () => {
    // Drive Date.now() to advance 5s per setTimeout tick (matching the
    // production DEEP_RESEARCH_POLL_INTERVAL_MS) so the heartbeat fires
    // after ~48 poll iterations (4 min / 5s).
    let simulatedNow = 0;
    const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => simulatedNow);
    setTimeoutSpy.mockRestore();
    setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
      simulatedNow += 5_000;
      Promise.resolve().then(fn);
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);

    // 1 submit + several IN_PROGRESS polls + COMPLETED.
    const fn = jest.fn();
    fn.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 'task-hb' }), text: async () => '' });
    // 60 in-progress polls is well past the 4-min heartbeat threshold.
    for (let i = 0; i < 60; i++) {
      fn.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ status: 'IN_PROGRESS' }), text: async () => '' });
    }
    fn.mockResolvedValueOnce({ ok: true, status: 200, json: async () => completedBody(0.5), text: async () => '' });
    global.fetch = fn as unknown as typeof fetch;

    const c = new PerplexityClient();
    const onHeartbeat = jest.fn().mockResolvedValue({ refreshed: true });
    // Allow the loop to run long simulated-time so heartbeat triggers.
    await c.deepResearch({ question: 'q', maxWaitMs: 10 * 60 * 1000 }, { onHeartbeat });
    expect(onHeartbeat).toHaveBeenCalled();

    dateNowSpy.mockRestore();
  });

  it('logs deep_research_heartbeat_stuck after 3 consecutive onHeartbeat failures', async () => {
    let simulatedNow = 0;
    const dateNowSpy = jest.spyOn(Date, 'now').mockImplementation(() => simulatedNow);
    setTimeoutSpy.mockRestore();
    setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
      simulatedNow += 5_000;
      Promise.resolve().then(fn);
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);

    const fn = jest.fn();
    fn.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ id: 'task-hb-fail' }), text: async () => '' });
    // Enough polls (~5 min × 60s) to cross 3 heartbeat intervals.
    for (let i = 0; i < 250; i++) {
      fn.mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ status: 'IN_PROGRESS' }), text: async () => '' });
    }
    fn.mockResolvedValueOnce({ ok: true, status: 200, json: async () => completedBody(0.5), text: async () => '' });
    global.fetch = fn as unknown as typeof fetch;

    const c = new PerplexityClient();
    const onHeartbeat = jest.fn().mockRejectedValue(new Error('db blip'));
    const { logger } = require('../../../infrastructure/logging') as {
      logger: { error: jest.Mock; warn: jest.Mock; info: jest.Mock; debug: jest.Mock };
    };
    await c.deepResearch({ question: 'q', maxWaitMs: 30 * 60 * 1000 }, { onHeartbeat });

    const stuckCalls = logger.error.mock.calls.filter(
      (call: unknown[]) => call[1] === 'deep_research_heartbeat_stuck',
    );
    expect(stuckCalls.length).toBeGreaterThanOrEqual(1);
    expect(onHeartbeat.mock.calls.length).toBeGreaterThanOrEqual(3);
    dateNowSpy.mockRestore();
  });
});

describe('PerplexityClient.call internals', () => {
  it('includes Authorization Bearer header', async () => {
    const fn = mockFetchSequence({ status: 200, body: agentResponse([
      { type: 'fetch_url_results', contents: [{ url: 'https://x', snippet: 'c' }] },
    ], 0.0005) });
    const c = new PerplexityClient();
    await c.fetch({ url: 'https://x' });
    const init = fn.mock.calls[0][1] as RequestInit;
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer api-key');
  });

  it('uses AbortSignal for each individual fetch (PERPLEXITY_TIMEOUT_MS = 30s)', async () => {
    const fn = mockFetchSequence({ status: 200, body: agentResponse([
      { type: 'fetch_url_results', contents: [{ url: 'https://x', snippet: 'c' }] },
    ], 0.0005) });
    const c = new PerplexityClient();
    await c.fetch({ url: 'https://x' });
    const init = fn.mock.calls[0][1] as RequestInit;
    expect(init.signal).toBeDefined();
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('wraps network failures as PerplexityError(msg, 0)', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('net down')) as unknown as typeof fetch;
    const c = new PerplexityClient();
    const err = await c.fetch({ url: 'https://x' }).catch(e => e);
    expect(err).toBeInstanceOf(PerplexityError);
    expect((err as PerplexityError).statusCode).toBe(0);
  });

  it('key() caches the API key across calls (only one getSecret call per client instance)', async () => {
    mockFetchSequence(
      { status: 200, body: agentResponse([{ type: 'fetch_url_results', contents: [{ url: 'https://a', snippet: 'a' }] }], 0.0005) },
      { status: 200, body: agentResponse([{ type: 'fetch_url_results', contents: [{ url: 'https://b', snippet: 'b' }] }], 0.0005) },
    );
    const c = new PerplexityClient();
    await c.fetch({ url: 'https://a' });
    await c.fetch({ url: 'https://b' });
    expect(mockGetSecret).toHaveBeenCalledTimes(1);
  });
});

describe('PerplexityClient.deepResearch — registry integration', () => {
  let setTimeoutSpy: jest.SpyInstance;
  beforeEach(() => {
    jest.clearAllMocks();
    mockGetSecret.mockResolvedValue('api-key');
    mockInsertSubmission.mockResolvedValue(undefined);
    mockFinalizeSubmission.mockResolvedValue(undefined);
    mockMarkPolled.mockResolvedValue(undefined);
    mockMarkHookActive.mockResolvedValue(undefined);
    jest.useRealTimers();
    setTimeoutSpy = jest.spyOn(global, 'setTimeout').mockImplementation(((fn: () => void) => {
      Promise.resolve().then(fn);
      return 0 as unknown as NodeJS.Timeout;
    }) as unknown as typeof setTimeout);
  });
  afterEach(() => { setTimeoutSpy.mockRestore(); });

  it('writes registry row immediately after submit succeeds', async () => {
    mockFetchSequence(
      { status: 200, body: { id: 'sub-1' } },
      { status: 200, body: {
        status: 'COMPLETED',
        response: {
          choices: [{ message: { content: 'r' } }],
          search_results: [],
          usage: { prompt_tokens: 100, completion_tokens: 50, cost: { currency: 'USD', total_cost: 0.50 } },
        },
      }},
    );
    const c = new PerplexityClient();
    const result = await c.deepResearch(
      { question: 'q', reasoningEffort: 'medium', tenantId: 't1', agentId: 'a1' },
    );
    expect(mockInsertSubmission).toHaveBeenCalledTimes(1);
    expect(mockInsertSubmission.mock.calls[0][0]).toMatchObject({
      submissionId: 'sub-1',
      tenantId:     't1',
      agentId:      'a1',
      reasoningEffort: 'medium',
    });
    expect(result.deepResearchId).toBeDefined();
  });

  it('continues when insertSubmission throws (logs registry_write_lost, returns result)', async () => {
    mockFetchSequence(
      { status: 200, body: { id: 'sub-1' } },
      { status: 200, body: {
        status: 'COMPLETED',
        response: {
          choices: [{ message: { content: 'r' } }],
          search_results: [],
          usage: { cost: { currency: 'USD', total_cost: 0.50 } },
        },
      }},
    );
    mockInsertSubmission.mockRejectedValueOnce(new Error('db blip'));
    const c = new PerplexityClient();
    const result = await c.deepResearch(
      { question: 'q', tenantId: 't1' },
    );
    expect(result.deepResearchId).toBeDefined();
  });

  it('calls finalizeSubmission(completed) on COMPLETED status', async () => {
    mockFetchSequence(
      { status: 200, body: { id: 'sub-1' } },
      { status: 200, body: {
        status: 'COMPLETED',
        response: {
          choices: [{ message: { content: 'r' } }],
          search_results: [],
          usage: { cost: { currency: 'USD', total_cost: 0.50 } },
        },
      }},
    );
    const c = new PerplexityClient();
    await c.deepResearch({ question: 'q', tenantId: 't1' });
    // Finalize is fire-and-forget; allow microtask flush.
    await new Promise(r => setImmediate(r));
    expect(mockFinalizeSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        finalStatus:     'completed',
        finalCostMicros: 500_000,
      }),
    );
  });

  it('calls finalizeSubmission(failed) on FAILED status with zero cost when no usage', async () => {
    mockFetchSequence(
      { status: 200, body: { id: 'sub-1' } },
      { status: 200, body: { status: 'FAILED', response: null, error_message: 'boom' } },
    );
    const c = new PerplexityClient();
    await c.deepResearch({ question: 'q', tenantId: 't1' }).catch(() => {});
    await new Promise(r => setImmediate(r));
    expect(mockFinalizeSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        finalStatus:     'failed',
        finalCostMicros: 0,
      }),
    );
  });

  it('extracts partial cost on FAILED when usage.cost.total_cost present (Gap #3)', async () => {
    mockFetchSequence(
      { status: 200, body: { id: 'sub-1' } },
      { status: 200, body: {
        status: 'FAILED',
        response: {
          choices: [],
          usage: { cost: { currency: 'USD', total_cost: 0.20 } },
        },
        error_message: 'failed mid',
      }},
    );
    const c = new PerplexityClient();
    await c.deepResearch({ question: 'q', tenantId: 't1' }).catch(() => {});
    await new Promise(r => setImmediate(r));
    expect(mockFinalizeSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        finalStatus:     'failed',
        finalCostMicros: 200_000,
      }),
    );
  });

  it('treats COMPLETED + null response as FAILED with 0 cost (Gap #4)', async () => {
    mockFetchSequence(
      { status: 200, body: { id: 'sub-1' } },
      { status: 200, body: { status: 'COMPLETED', response: null } },
    );
    const c = new PerplexityClient();
    await c.deepResearch({ question: 'q', tenantId: 't1' }).catch(() => {});
    await new Promise(r => setImmediate(r));
    expect(mockFinalizeSubmission).toHaveBeenCalledWith(
      expect.objectContaining({
        finalStatus:     'failed',
        finalCostMicros: 0,
      }),
    );
  });

  it('skips registry write when req.tenantId is undefined', async () => {
    mockFetchSequence(
      { status: 200, body: { id: 'sub-1' } },
      { status: 200, body: {
        status: 'COMPLETED',
        response: {
          choices: [{ message: { content: 'r' } }],
          search_results: [],
          usage: { cost: { currency: 'USD', total_cost: 0.50 } },
        },
      }},
    );
    const c = new PerplexityClient();
    await c.deepResearch({ question: 'q' });
    await new Promise(r => setImmediate(r));
    expect(mockInsertSubmission).not.toHaveBeenCalled();
    expect(mockFinalizeSubmission).not.toHaveBeenCalled();
  });

  it('calls markPolled and NOT finalizeSubmission on 408 ceiling (Gap)', async () => {
    // Submit succeeds; poll never returns COMPLETED/FAILED → exits via 408.
    // maxWaitMs=1 forces an immediate ceiling exit; the stubbed setTimeout
    // fires the resolved poll immediately, so the loop runs one iteration
    // and then trips Date.now() - startMs < maxWaitMs.
    const fetchFn = jest.fn();
    // Submit response
    fetchFn.mockResolvedValueOnce({
      ok: true, status: 200,
      json: async () => ({ id: 'sub-1' }), text: async () => '',
    });
    // Always IN_PROGRESS — never completes
    fetchFn.mockResolvedValue({
      ok: true, status: 200,
      json: async () => ({ status: 'IN_PROGRESS', response: null }), text: async () => '',
    });
    global.fetch = fetchFn as unknown as typeof fetch;
    const c = new PerplexityClient();
    const err = await c.deepResearch(
      { question: 'q', tenantId: 't1', maxWaitMs: 1 },
    ).catch(e => e as PerplexityError);
    expect(err).toBeInstanceOf(PerplexityError);
    expect((err as PerplexityError).statusCode).toBe(408);
    await new Promise(r => setImmediate(r));
    expect(mockMarkPolled).toHaveBeenCalledWith(expect.any(String));
    expect(mockFinalizeSubmission).not.toHaveBeenCalled();
  });

  it('calls markHookActive on every poll iteration (Gap #5)', async () => {
    mockFetchSequence(
      { status: 200, body: { id: 'sub-1' } },
      { status: 200, body: { status: 'IN_PROGRESS', response: null } },
      { status: 200, body: {
        status: 'COMPLETED',
        response: {
          choices: [{ message: { content: 'r' } }],
          search_results: [],
          usage: { cost: { currency: 'USD', total_cost: 0.50 } },
        },
      }},
    );
    const c = new PerplexityClient();
    await c.deepResearch({ question: 'q', tenantId: 't1' });
    // 2 poll iterations → 2 hook heartbeats
    await new Promise(r => setImmediate(r));
    expect(mockMarkHookActive.mock.calls.length).toBeGreaterThanOrEqual(1);
    expect(mockMarkHookActive.mock.calls[0][1]).toBe(30);
  });
});
