const mockGetSecret = jest.fn();
const mockGetWebToolCredential = jest.fn();
jest.mock('../../../infrastructure/secrets', () => ({
  getSecret: (...a: unknown[]) => mockGetSecret(...a),
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// BYOK refactor (ADR-023): ExaClient now resolves credentials per-tenant via
// `getWebToolCredential` instead of `getWebToolSecret`. Stub the resolver so
// every call gets the same fake key — tests don't pin tenantId because the
// fetch surface is what matters here.
jest.mock('../web-tool-secrets', () => {
  const actual = jest.requireActual('../web-tool-secrets');
  return {
    ...actual,
    getWebToolCredential: (...a: unknown[]) => mockGetWebToolCredential(...a),
  };
});

import { ExaClient, ExaError } from '../exa-client';

const originalFetch = global.fetch;
afterAll(() => { global.fetch = originalFetch; });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSecret.mockResolvedValue('exa-test-key');
  mockGetWebToolCredential.mockResolvedValue({
    apiKey: 'exa-test-key',
    connectorId: 'conn-exa',
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

describe('ExaClient.fetch', () => {
  it('returns text on happy path with exact-cost capture from costDollars.total', async () => {
    mockFetch(200, {
      results: [{ url: 'https://example.com', title: 'Example', text: 'page text' }],
      costDollars: { total: 0.001 },
      requestId: 'x',
    });
    const c = new ExaClient();
    const out = await c.fetch({ url: 'https://example.com' });
    expect(out.content).toBe('page text');
    expect(out.finalUrl).toBe('https://example.com');
    expect(out.vendor).toBe('exa');
    // 0.001 * 1_000_000 = 1000 micros
    expect(out.costMicros).toBe(1000);
    expect(out.jsRendered).toBe(false);
    expect(out.sessionId).toBeUndefined();
  });

  it('outgoing body has urls plural array and text:true', async () => {
    const fn = mockFetch(200, {
      results: [{ url: 'https://example.com', text: 'page text' }],
      costDollars: { total: 0.001 },
      requestId: 'x',
    });
    const c = new ExaClient();
    await c.fetch({ url: 'https://example.com' });
    const call = fn.mock.calls[0];
    const sentBody = JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
    expect(sentBody.urls).toEqual(['https://example.com']);
    expect(sentBody.text).toBe(true);
  });

  it('throws ExaError when text is empty (antibot)', async () => {
    mockFetch(200, {
      results: [{ url: 'https://example.com', text: '' }],
      costDollars: { total: 0.001 },
      requestId: 'x',
    });
    const c = new ExaClient();
    const err = await c.fetch({ url: 'https://example.com' }).catch(e => e);
    expect(err).toBeInstanceOf(ExaError);
    expect((err as ExaError).statusCode).toBe(200);
    expect((err as Error).message).toMatch(/Empty content/);
  });

  it('throws ExaError when results is empty', async () => {
    mockFetch(200, {
      results: [],
      costDollars: { total: 0.001 },
      requestId: 'x',
    });
    const c = new ExaClient();
    const err = await c.fetch({ url: 'https://example.com' }).catch(e => e);
    expect(err).toBeInstanceOf(ExaError);
    expect((err as Error).message).toMatch(/Empty content/);
  });

  it('rejects sessionId with 400 ExaError', async () => {
    const c = new ExaClient();
    const err = await c.fetch({ url: 'https://example.com', sessionId: 's-1' }).catch(e => e);
    expect(err).toBeInstanceOf(ExaError);
    expect((err as ExaError).statusCode).toBe(400);
    expect((err as Error).message).toMatch(/does not support sessions/);
  });

  it('rejects vendorProfileId with 400 ExaError', async () => {
    const c = new ExaClient();
    const err = await c.fetch({ url: 'https://example.com', vendorProfileId: 'p-1' }).catch(e => e);
    expect(err).toBeInstanceOf(ExaError);
    expect((err as ExaError).statusCode).toBe(400);
    expect((err as Error).message).toMatch(/vendor profiles/);
  });

  it('rejects vendorIdentityId with 400 ExaError', async () => {
    const c = new ExaClient();
    const err = await c.fetch({ url: 'https://example.com', vendorIdentityId: 'i-1' }).catch(e => e);
    expect(err).toBeInstanceOf(ExaError);
    expect((err as ExaError).statusCode).toBe(400);
    expect((err as Error).message).toMatch(/vendor identities/);
  });

  it('silently ignores waitFor — outgoing body still only has urls + text', async () => {
    const fn = mockFetch(200, {
      results: [{ url: 'https://example.com', text: 'page text' }],
      costDollars: { total: 0.001 },
      requestId: 'x',
    });
    const c = new ExaClient();
    const out = await c.fetch({ url: 'https://example.com', waitFor: { type: 'networkidle' } as never });
    expect(out.content).toBe('page text');
    const call = fn.mock.calls[0];
    const sentBody = JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
    expect(Object.keys(sentBody).sort()).toEqual(['text', 'urls']);
  });

  it('throws ExaError(422) when costDollars missing entirely', async () => {
    mockFetch(200, {
      results: [{ url: 'https://example.com', text: 'page text' }],
      requestId: 'x',
    });
    const c = new ExaClient();
    const err = await c.fetch({ url: 'https://example.com' }).catch(e => e);
    expect(err).toBeInstanceOf(ExaError);
    expect((err as ExaError).statusCode).toBe(422);
    expect((err as Error).message).toMatch(/missing costDollars.total/);
  });

  it('throws ExaError(422) when costDollars.total is missing', async () => {
    mockFetch(200, {
      results: [{ url: 'https://example.com', text: 'page text' }],
      costDollars: {},
      requestId: 'x',
    });
    const c = new ExaClient();
    const err = await c.fetch({ url: 'https://example.com' }).catch(e => e);
    expect(err).toBeInstanceOf(ExaError);
    expect((err as ExaError).statusCode).toBe(422);
  });

  it('throws ExaError(422) when costDollars.total is negative (refuses to bill)', async () => {
    mockFetch(200, {
      results: [{ url: 'https://example.com', text: 'page text' }],
      costDollars: { total: -0.001 },
      requestId: 'x',
    });
    const c = new ExaClient();
    const err = await c.fetch({ url: 'https://example.com' }).catch(e => e);
    expect(err).toBeInstanceOf(ExaError);
    expect((err as ExaError).statusCode).toBe(422);
    expect((err as Error).message).toMatch(/negative/);
  });

  it('throws ExaError on HTTP 500', async () => {
    mockFetch(500, { requestId: 'r', error: 'oops', tag: 'INTERNAL' });
    const c = new ExaClient();
    const err = await c.fetch({ url: 'https://example.com' }).catch(e => e);
    expect(err).toBeInstanceOf(ExaError);
    expect((err as ExaError).statusCode).toBe(500);
  });

  it('throws ExaError on HTTP 429 with {error} only', async () => {
    mockFetch(429, { error: 'rate limited' });
    const c = new ExaClient();
    const err = await c.fetch({ url: 'https://example.com' }).catch(e => e);
    expect(err).toBeInstanceOf(ExaError);
    expect((err as ExaError).statusCode).toBe(429);
    expect((err as Error).message).toMatch(/rate limited/);
  });

  it('includes [tag] suffix on HTTP 400 with {requestId, error, tag}', async () => {
    mockFetch(400, { requestId: 'r', error: 'bad input', tag: 'INVALID_REQUEST' });
    const c = new ExaClient();
    const err = await c.fetch({ url: 'https://example.com' }).catch(e => e);
    expect(err).toBeInstanceOf(ExaError);
    expect((err as ExaError).statusCode).toBe(400);
    expect((err as Error).message).toMatch(/\[INVALID_REQUEST\]/);
  });

  it('throws ExaError with statusCode 0 on network error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('network down')) as unknown as typeof fetch;
    const c = new ExaClient();
    const err = await c.fetch({ url: 'https://example.com' }).catch(e => e);
    expect(err).toBeInstanceOf(ExaError);
    expect((err as ExaError).statusCode).toBe(0);
    expect((err as Error).message).toMatch(/Network/);
  });

  it('reads on the platform\'s pay-as-you-go key when no exa connector is bound, and says so', async () => {
    const { VendorNotConnected } = jest.requireActual('../web-tool-secrets');
    mockGetWebToolCredential.mockRejectedValueOnce(new VendorNotConnected('exa'));
    mockGetSecret.mockResolvedValueOnce('platform-exa-key');
    const fn = mockFetch(200, { results: [{ url: 'https://example.com', text: 'page text' }], costDollars: { total: 0.001 }, requestId: 'x' });
    const c = new ExaClient();
    const out = await c.fetch({ url: 'https://example.com' });
    expect(out.funding).toBe('platform');
    expect(mockGetSecret).toHaveBeenCalledWith(expect.stringMatching(/secrets\/exa-api-key$/));
    const headers = (fn.mock.calls[0][1] as { headers: Record<string, string> }).headers;
    expect(headers['x-api-key']).toBe('platform-exa-key');
  });

  it('a platform key that cannot be read is a 503, so the router parks the rung rather than spending an attempt on it every call', async () => {
    const { VendorNotConnected } = jest.requireActual('../web-tool-secrets');
    mockGetWebToolCredential.mockRejectedValueOnce(new VendorNotConnected('exa'));
    mockGetSecret.mockRejectedValueOnce(new Error('Failed to load secret: projects/YOUR_PROJECT/secrets/exa-api-key'));
    const fn = jest.fn();
    global.fetch = fn as unknown as typeof fetch;
    const err = await new ExaClient().fetch({ url: 'https://example.com' }).catch((e) => e);
    expect(err.name).toBe('ExaError');
    expect(err.statusCode).toBe(503);
    expect(err.message).toMatch(/platform key unavailable/);
    expect(fn).not.toHaveBeenCalled();
  });

  it('a page read on a bound connector carries no funding label, so the ledger books it as the team\'s own key', async () => {
    mockFetch(200, { results: [{ url: 'https://example.com', text: 'page text' }], costDollars: { total: 0.001 }, requestId: 'x' });
    const c = new ExaClient();
    const out = await c.fetch({ url: 'https://example.com' });
    expect(out.funding).toBeUndefined();
  });

  it('sends x-api-key header (NOT Authorization Bearer)', async () => {
    const fn = mockFetch(200, {
      results: [{ url: 'https://example.com', text: 'page text' }],
      costDollars: { total: 0.001 },
      requestId: 'x',
    });
    const c = new ExaClient();
    await c.fetch({ url: 'https://example.com' });
    const call = fn.mock.calls[0];
    const headers = (call[1] as { headers: Record<string, string> }).headers;
    expect(headers['x-api-key']).toBe('exa-test-key');
    expect(headers.Authorization).toBeUndefined();
    expect(headers['Content-Type']).toBe('application/json');
  });
});

describe('ExaClient.research', () => {
  it('returns answer + sources on happy path with exact-cost capture', async () => {
    mockFetch(200, {
      answer: 'synthesized',
      citations: [
        { url: 'https://a', title: 'A', text: 'snippet A' },
        { url: 'https://b', title: 'B', text: 'snippet B' },
      ],
      costDollars: { total: 0.007 },
      requestId: 'r',
    });
    const c = new ExaClient();
    const out = await c.research({ question: 'q' });
    expect(out.answer).toBe('synthesized');
    expect(out.sources).toEqual([
      { url: 'https://a', title: 'A', snippet: 'snippet A' },
      { url: 'https://b', title: 'B', snippet: 'snippet B' },
    ]);
    expect(out.vendor).toBe('exa');
    // 0.007 * 1_000_000 = 7000 micros
    expect(out.costMicros).toBe(7000);
  });

  it('outgoing body has query + text:true only (no maxSources sent)', async () => {
    const fn = mockFetch(200, {
      answer: 'a',
      citations: [],
      costDollars: { total: 0.007 },
      requestId: 'r',
    });
    const c = new ExaClient();
    await c.research({ question: 'q' });
    const call = fn.mock.calls[0];
    const sentBody = JSON.parse((call[1] as { body: string }).body) as Record<string, unknown>;
    expect(Object.keys(sentBody).sort()).toEqual(['query', 'text']);
    expect(sentBody.query).toBe('q');
    expect(sentBody.text).toBe(true);
  });

  it('trims citations to min(maxSources, MAX_RESULTS_CEILING=25)', async () => {
    const citations = Array.from({ length: 30 }, (_, i) => ({ url: `https://${i}`, title: `T${i}`, text: `snippet ${i}` }));
    mockFetch(200, {
      answer: 'a',
      citations,
      costDollars: { total: 0.007 },
      requestId: 'r',
    });
    const c = new ExaClient();
    const out = await c.research({ question: 'q', maxSources: 50 });
    // maxSources 50 → clamped to 25
    expect(out.sources).toHaveLength(25);
  });

  it('honors maxSources when below ceiling', async () => {
    const citations = Array.from({ length: 30 }, (_, i) => ({ url: `https://${i}`, title: `T${i}`, text: `snippet ${i}` }));
    mockFetch(200, {
      answer: 'a',
      citations,
      costDollars: { total: 0.007 },
      requestId: 'r',
    });
    const c = new ExaClient();
    const out = await c.research({ question: 'q', maxSources: 5 });
    expect(out.sources).toHaveLength(5);
  });

  it('truncates snippet to 500 chars', async () => {
    const longText = 'x'.repeat(1000);
    mockFetch(200, {
      answer: 'a',
      citations: [{ url: 'https://a', title: 'A', text: longText }],
      costDollars: { total: 0.007 },
      requestId: 'r',
    });
    const c = new ExaClient();
    const out = await c.research({ question: 'q' });
    expect(out.sources[0].snippet.length).toBe(500);
  });

  it('throws ExaError(422) when costDollars missing on research', async () => {
    mockFetch(200, {
      answer: 'a',
      citations: [{ url: 'https://a', title: 'A', text: 's' }],
      requestId: 'r',
    });
    const c = new ExaClient();
    const err = await c.research({ question: 'q' }).catch(e => e);
    expect(err).toBeInstanceOf(ExaError);
    expect((err as ExaError).statusCode).toBe(422);
  });
});
