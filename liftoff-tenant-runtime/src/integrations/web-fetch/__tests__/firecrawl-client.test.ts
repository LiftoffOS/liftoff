const mockGetSecret = jest.fn();
const mockGetWebToolCredential = jest.fn();
jest.mock('../../../infrastructure/secrets', () => ({
  getSecret: (...a: unknown[]) => mockGetSecret(...a),
}));
jest.mock('../../../infrastructure/logging', () => ({
  logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));
// BYOK refactor (ADR-023): FirecrawlClient resolves credentials per-tenant.
jest.mock('../web-tool-secrets', () => {
  const actual = jest.requireActual('../web-tool-secrets');
  return {
    ...actual,
    getWebToolCredential: (...a: unknown[]) => mockGetWebToolCredential(...a),
  };
});

import { FirecrawlClient, FirecrawlError } from '../firecrawl-client';

const originalFetch = global.fetch;
afterAll(() => { global.fetch = originalFetch; });

beforeEach(() => {
  jest.clearAllMocks();
  mockGetSecret.mockResolvedValue('api-key');
  mockGetWebToolCredential.mockResolvedValue({
    apiKey: 'api-key',
    connectorId: 'conn-firecrawl',
    extra: {},
  });
});

function mockFetch(status: number, body: unknown) {
  global.fetch = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    statusText: status === 401 ? 'Unauthorized' : status === 429 ? 'Too Many Requests' : 'Error',
    json: async () => body,
  }) as unknown as typeof fetch;
}

describe('FirecrawlClient.fetch', () => {
  it('returns the markdown payload on success', async () => {
    mockFetch(200, { success: true, data: { markdown: '# hi', metadata: { sourceURL: 'https://x' } } });
    const c = new FirecrawlClient();
    const out = await c.fetch({ url: 'https://x' });
    expect(out.content).toBe('# hi');
    expect(out.vendor).toBe('firecrawl');
    expect(out.jsRendered).toBe(false);
    expect(out.finalUrl).toBe('https://x');
  });

  it('throws BYOKVendorError on 401 (invalid_key classification flips connector to errored)', async () => {
    const { BYOKVendorError } = jest.requireActual('../types');
    mockFetch(401, { error: 'bad key' });
    const c = new FirecrawlClient();
    await expect(c.fetch({ url: 'https://x' })).rejects.toBeInstanceOf(BYOKVendorError);
  });

  it('throws FirecrawlError on 429 (free-tier rate-limit / cap)', async () => {
    mockFetch(429, { error: 'rate limited' });
    const c = new FirecrawlClient();
    const err = await c.fetch({ url: 'https://x' }).catch(e => e);
    expect(err).toBeInstanceOf(FirecrawlError);
    expect((err as FirecrawlError).statusCode).toBe(429);
  });

  it('throws when markdown is empty (antibot block)', async () => {
    mockFetch(200, { success: true, data: { markdown: '', metadata: { sourceURL: 'https://x' } } });
    const c = new FirecrawlClient();
    await expect(c.fetch({ url: 'https://x' })).rejects.toThrow(/Empty markdown/);
  });

  it('refuses session_id requests (Firecrawl is stateless)', async () => {
    const c = new FirecrawlClient();
    await expect(c.fetch({ url: 'https://x', sessionId: 's1' }))
      .rejects.toThrow(/Firecrawl does not support sessions/);
  });
});

describe('FirecrawlClient.extract', () => {
  it('returns the extracted json payload on success', async () => {
    mockFetch(200, {
      success: true,
      data: {
        json: { title: 'page' },
        metadata: { sourceURL: 'https://x' },
      },
    });
    const c = new FirecrawlClient();
    const out = await c.extract({ url: 'https://x', schema: { type: 'object' } });
    expect(out.data).toEqual({ title: 'page' });
    expect(out.vendor).toBe('firecrawl');
    expect(out.finalUrl).toBe('https://x');
  });
});

describe('FirecrawlClient.research', () => {
  it('synthesizes answer from /search response', async () => {
    mockFetch(200, {
      success: true,
      data: {
        answer: 'synthesized answer',
        web: [
          { url: 'https://a', title: 'A', description: 'desc A' },
          { url: 'https://b', title: 'B', description: 'desc B' },
        ],
      },
    });
    const c = new FirecrawlClient();
    const out = await c.research({ question: 'what is X?' });
    expect(out.answer).toBe('synthesized answer');
    expect(out.sources).toEqual([
      { url: 'https://a', title: 'A' },
      { url: 'https://b', title: 'B' },
    ]);
    expect(out.vendor).toBe('firecrawl');
  });

  it('falls back to concatenated hits when answer is not returned', async () => {
    mockFetch(200, {
      success: true,
      data: {
        web: [
          { url: 'https://a', title: 'A', description: 'desc A' },
        ],
      },
    });
    const c = new FirecrawlClient();
    const out = await c.research({ question: 'what is X?' });
    expect(typeof out.answer).toBe('string');
    expect(out.answer).toMatch(/A/);
  });
});
