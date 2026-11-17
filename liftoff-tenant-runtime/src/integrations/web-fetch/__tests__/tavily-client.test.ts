const mockGetSecret = jest.fn();
const mockGetWebToolCredential = jest.fn();
jest.mock('../../../infrastructure/secrets', () => ({
  getSecret: (...a: unknown[]) => mockGetSecret(...a),
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// BYOK refactor (ADR-023): TavilyClient resolves credentials per-tenant.
jest.mock('../web-tool-secrets', () => {
  const actual = jest.requireActual('../web-tool-secrets');
  return {
    ...actual,
    getWebToolCredential: (...a: unknown[]) => mockGetWebToolCredential(...a),
  };
});

import { TavilyClient, TavilyError } from '../tavily-client';

const originalFetch = global.fetch;
afterAll(() => { global.fetch = originalFetch; });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSecret.mockResolvedValue('tvly-test-key');
  mockGetWebToolCredential.mockResolvedValue({
    apiKey: 'tvly-test-key',
    connectorId: 'conn-tavily',
    extra: {},
  });
});

interface MockResponse {
  ok: boolean;
  status: number;
  statusText: string;
  json: () => Promise<unknown>;
}

function mockFetch(status: number, body: unknown): jest.Mock {
  const fn = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? 'Unauthorized' : status === 429 ? 'Too Many Requests' : status === 500 ? 'Server Error' : 'Error',
    json: async () => body,
  } as MockResponse);
  global.fetch = fn as unknown as typeof fetch;
  return fn;
}

describe('TavilyClient.fetch', () => {
  it('returns raw_content on happy path with paygo-rate cost', async () => {
    mockFetch(200, {
      results: [{ url: 'https://example.com', title: 'Example', raw_content: 'page text', images: [] }],
      failed_results: [],
      response_time: 0.01,
      usage: { credits: 0.2 },
      request_id: 'x',
    });
    const c = new TavilyClient();
    const out = await c.fetch({ url: 'https://example.com' });
    expect(out.content).toBe('page text');
    expect(out.finalUrl).toBe('https://example.com');
    expect(out.vendor).toBe('tavily');
    // USD_PER_CREDIT=0.008 (paygo) × 0.2 credits × 1e6 = 1600 micros
    expect(out.costMicros).toBe(1600);
    expect(out.jsRendered).toBe(false);
    expect(out.sessionId).toBeUndefined();
  });

  it('throws TavilyError when raw_content is empty (antibot)', async () => {
    mockFetch(200, {
      results: [{ url: 'https://example.com', raw_content: '' }],
      failed_results: [],
      response_time: 0.01,
      usage: { credits: 0 },
      request_id: 'x',
    });
    const c = new TavilyClient();
    const err = await c.fetch({ url: 'https://example.com' }).catch(e => e);
    expect(err).toBeInstanceOf(TavilyError);
    expect((err as TavilyError).statusCode).toBe(200);
    expect((err as Error).message).toMatch(/Empty content/);
  });

  it('embeds failed_results error message when extract failed', async () => {
    mockFetch(200, {
      results: [],
      failed_results: [{ url: 'https://example.com', error: 'blocked by antibot' }],
      response_time: 0.01,
      usage: { credits: 0 },
      request_id: 'x',
    });
    const c = new TavilyClient();
    const err = await c.fetch({ url: 'https://example.com' }).catch(e => e);
    expect(err).toBeInstanceOf(TavilyError);
    expect((err as Error).message).toMatch(/blocked by antibot/);
  });

  it('rejects sessionId with 400 TavilyError', async () => {
    const c = new TavilyClient();
    const err = await c.fetch({ url: 'https://example.com', sessionId: 's-1' }).catch(e => e);
    expect(err).toBeInstanceOf(TavilyError);
    expect((err as TavilyError).statusCode).toBe(400);
    expect((err as Error).message).toMatch(/does not support sessions/);
  });

  it('rejects vendorProfileId with 400 TavilyError', async () => {
    const c = new TavilyClient();
    const err = await c.fetch({ url: 'https://example.com', vendorProfileId: 'p-1' }).catch(e => e);
    expect(err).toBeInstanceOf(TavilyError);
    expect((err as TavilyError).statusCode).toBe(400);
    expect((err as Error).message).toMatch(/vendor profiles/);
  });

  it('rejects vendorIdentityId with 400 TavilyError', async () => {
    const c = new TavilyClient();
    const err = await c.fetch({ url: 'https://example.com', vendorIdentityId: 'i-1' }).catch(e => e);
    expect(err).toBeInstanceOf(TavilyError);
    expect((err as TavilyError).statusCode).toBe(400);
    expect((err as Error).message).toMatch(/vendor identities/);
  });

  it('silently ignores waitFor — outgoing body has only urls/extract_depth/include_usage', async () => {
    const fn = mockFetch(200, {
      results: [{ url: 'https://example.com', raw_content: 'page text' }],
      failed_results: [],
      response_time: 0.01,
      usage: { credits: 0 },
      request_id: 'x',
    });
    const c = new TavilyClient();
    const out = await c.fetch({ url: 'https://example.com', waitFor: { type: 'networkidle' } as never });
    expect(out.content).toBe('page text');
    const call = fn.mock.calls[0];
    const sentBody = JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
    expect(Object.keys(sentBody).sort()).toEqual(['extract_depth', 'include_usage', 'urls']);
    expect(sentBody.urls).toEqual(['https://example.com']);
    expect(sentBody.extract_depth).toBe('basic');
    expect(sentBody.include_usage).toBe(true);
  });

  it('throws TavilyError on HTTP 500', async () => {
    mockFetch(500, { error: 'oops' });
    const c = new TavilyClient();
    const err = await c.fetch({ url: 'https://example.com' }).catch(e => e);
    expect(err).toBeInstanceOf(TavilyError);
    expect((err as TavilyError).statusCode).toBe(500);
  });

  it('throws TavilyError on HTTP 429', async () => {
    mockFetch(429, { error: 'rate limited' });
    const c = new TavilyClient();
    const err = await c.fetch({ url: 'https://example.com' }).catch(e => e);
    expect(err).toBeInstanceOf(TavilyError);
    expect((err as TavilyError).statusCode).toBe(429);
  });

  it('throws TavilyError with statusCode 0 on network error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    const c = new TavilyClient();
    const err = await c.fetch({ url: 'https://example.com' }).catch(e => e);
    expect(err).toBeInstanceOf(TavilyError);
    expect((err as TavilyError).statusCode).toBe(0);
    expect((err as Error).message).toMatch(/Network/);
  });

  it('reads on the platform\'s pay-as-you-go key when no tavily connector is bound, and says so', async () => {
    const { VendorNotConnected } = jest.requireActual('../web-tool-secrets');
    mockGetWebToolCredential.mockRejectedValueOnce(new VendorNotConnected('tavily'));
    mockGetSecret.mockResolvedValueOnce('platform-tavily-key');
    const fn = mockFetch(200, { results: [{ url: 'https://example.com', raw_content: 'page text' }], failed_results: [], response_time: 0.01, usage: { credits: 0.2 }, request_id: 'x' });
    const c = new TavilyClient();
    const out = await c.fetch({ url: 'https://example.com' });
    expect(out.funding).toBe('platform');
    expect(mockGetSecret).toHaveBeenCalledWith(expect.stringMatching(/secrets\/tavily-api-key$/));
    const headers = (fn.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer platform-tavily-key');
  });

  it('a platform key that cannot be read is a 503, so the router parks the rung rather than spending an attempt on it every call', async () => {
    const { VendorNotConnected } = jest.requireActual('../web-tool-secrets');
    mockGetWebToolCredential.mockRejectedValueOnce(new VendorNotConnected('tavily'));
    mockGetSecret.mockRejectedValueOnce(new Error('Failed to load secret: projects/YOUR_PROJECT/secrets/tavily-api-key'));
    const fn = jest.fn();
    global.fetch = fn as unknown as typeof fetch;
    const err = await new TavilyClient().fetch({ url: 'https://example.com' }).catch((e) => e);
    expect(err.name).toBe('TavilyError');
    expect(err.statusCode).toBe(503);
    expect(err.message).toMatch(/platform key unavailable/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('a page read on a bound connector carries no funding label, so the ledger books it as the team\'s own key', async () => {
    mockFetch(200, { results: [{ url: 'https://example.com', raw_content: 'page text' }], failed_results: [], response_time: 0.01, usage: { credits: 0.2 }, request_id: 'x' });
    const c = new TavilyClient();
    const out = await c.fetch({ url: 'https://example.com' });
    expect(out.funding).toBeUndefined();
  });

  it('sends Authorization: Bearer <key>', async () => {
    const fn = mockFetch(200, {
      results: [{ url: 'https://example.com', raw_content: 'page text' }],
      failed_results: [],
      response_time: 0.01,
      usage: { credits: 0 },
      request_id: 'x',
    });
    const c = new TavilyClient();
    await c.fetch({ url: 'https://example.com' });
    const call = fn.mock.calls[0];
    const headers = (call[1] as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBe('Bearer tvly-test-key');
    expect(headers['Content-Type']).toBe('application/json');
  });
});

describe('TavilyClient.research', () => {
  it('returns answer + sources on happy path with paygo-rate cost', async () => {
    mockFetch(200, {
      query: 'q',
      follow_up_questions: null,
      answer: 'synthesized',
      images: [],
      results: [
        { url: 'https://a', title: 'A', content: 'snippet A', score: 0.9, raw_content: null },
        { url: 'https://b', title: 'B', content: 'snippet B', score: 0.8, raw_content: null },
      ],
      response_time: 1.0,
      usage: { credits: 1 },
      request_id: 'r',
    });
    const c = new TavilyClient();
    const out = await c.research({ question: 'q' });
    expect(out.answer).toBe('synthesized');
    expect(out.sources).toEqual([
      { url: 'https://a', title: 'A', snippet: 'snippet A' },
      { url: 'https://b', title: 'B', snippet: 'snippet B' },
    ]);
    expect(out.vendor).toBe('tavily');
    // USD_PER_CREDIT=0.008 (paygo) × 1 credit × 1e6 = 8000 micros
    expect(out.costMicros).toBe(8000);
  });

  it('falls back to joined title+content when answer is null', async () => {
    mockFetch(200, {
      query: 'q',
      follow_up_questions: null,
      answer: null,
      images: [],
      results: [
        { url: 'https://a', title: 'A', content: 'snippet A', score: 0.9, raw_content: null },
        { url: 'https://b', title: 'B', content: 'snippet B', score: 0.8, raw_content: null },
      ],
      response_time: 1.0,
      usage: { credits: 1 },
      request_id: 'r',
    });
    const c = new TavilyClient();
    const out = await c.research({ question: 'q' });
    expect(out.answer).toBe('A\nsnippet A\n\nB\nsnippet B');
  });

  it('clamps maxSources to 20 (MAX_RESULTS_CEILING)', async () => {
    const fn = mockFetch(200, {
      query: 'q',
      follow_up_questions: null,
      answer: 'a',
      images: [],
      results: [],
      response_time: 0,
      usage: { credits: 1 },
      request_id: 'r',
    });
    const c = new TavilyClient();
    await c.research({ question: 'q', maxSources: 50 });
    const call = fn.mock.calls[0];
    const sentBody = JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
    expect(sentBody.max_results).toBe(20);
  });

  it('outgoing body has include_answer:true and include_usage:true', async () => {
    const fn = mockFetch(200, {
      query: 'q',
      follow_up_questions: null,
      answer: 'a',
      images: [],
      results: [],
      response_time: 0,
      usage: { credits: 1 },
      request_id: 'r',
    });
    const c = new TavilyClient();
    await c.research({ question: 'q' });
    const call = fn.mock.calls[0];
    const sentBody = JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
    expect(sentBody.include_answer).toBe(true);
    expect(sentBody.include_usage).toBe(true);
    expect(sentBody.query).toBe('q');
    expect(sentBody.search_depth).toBe('basic');
  });
});
