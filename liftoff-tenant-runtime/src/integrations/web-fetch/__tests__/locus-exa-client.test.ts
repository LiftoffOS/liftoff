// The Exa overflow rung talks to connector-service, never to the vendor: the
// same page read and search the platform serves on its Exa key, on the Locus
// key when that key is rate-limited, booked platform-funded at the charge
// Locus reported.

const mockExecute = jest.fn();
jest.mock('../../../connectors/connector-service-client', () => ({
  getConnectorServiceClient: () => ({ execute: mockExecute }),
}));

import { LocusExaClient } from '../locus-exa-client';

const ctx = { tenantId: 't1', traceId: 'trace1' };

beforeEach(() => jest.clearAllMocks());

describe('fetch', () => {
  it('dispatches web_page_text on the platform identity and maps the page', async () => {
    mockExecute.mockResolvedValue({
      success: true,
      result: { requestId: 'r1', results: [{ id: 'https://example.com/', url: 'https://example.com/', title: 'Example Domain', text: 'Example Domain\n\nThis domain…' }], costDollars: { total: 0.001 } },
      costUsd: 0.001,
      fundingSource: 'platform_key',
    });
    const out = await new LocusExaClient().fetch({ url: 'https://example.com', ...ctx });
    expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({
      tenantContext: { tenantId: 't1' },
      connectorId: 'internal:locus',
      functionName: 'web_page_text',
      input: { urls: ['https://example.com'], text: true },
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      traceId: 'trace1',
    }));
    expect(out).toEqual({
      content: 'Example Domain\n\nThis domain…',
      finalUrl: 'https://example.com/',
      vendor: 'locus_exa',
      costMicros: 1_000,
      jsRendered: false,
      funding: 'platform',
    });
  });

  it('refuses a response with no page text rather than returning an empty page', async () => {
    mockExecute.mockResolvedValue({ success: true, result: { results: [{ url: 'https://example.com', text: '' }] }, costUsd: 0.001 });
    await expect(new LocusExaClient().fetch({ url: 'https://example.com', ...ctx }))
      .rejects.toMatchObject({ name: 'LocusWebError', statusCode: 502 });
  });
});

describe('research', () => {
  it('asks for each page\'s text and answers with the joined pages, the way Tavily answers without one', async () => {
    mockExecute.mockResolvedValue({
      success: true,
      result: { results: [{ url: 'https://a', title: 'A', text: 'text a' }, { url: 'https://b', title: '', text: 'text b' }, { title: 'no url' }], costDollars: { total: 0.006 } },
      costUsd: 0.006,
      fundingSource: 'platform_key',
    });
    const out = await new LocusExaClient().research({ question: 'q', maxSources: 20, ...ctx });
    expect(mockExecute.mock.calls[0][0]).toMatchObject({ functionName: 'web_semantic_search', input: { query: 'q', numResults: 10, type: 'auto', contents: { text: true } } });
    expect(out.sources).toEqual([{ url: 'https://a', title: 'A', snippet: 'text a' }, { url: 'https://b', title: 'https://b', snippet: 'text b' }]);
    expect(out.answer).toBe('A\ntext a\n\nhttps://b\ntext b');
    expect(out).toMatchObject({ vendor: 'locus_exa', costMicros: 6_000, funding: 'platform' });
  });
});

describe('refusals', () => {
  it('reads an empty Locus balance as a 402 and a rate limit as a 429', async () => {
    mockExecute.mockResolvedValue({ success: false, error: 'locus web_page_text failed: HTTP 402 payment required: insufficient credits', errorCode: 'vendor_error' });
    await expect(new LocusExaClient().fetch({ url: 'https://example.com', ...ctx })).rejects.toMatchObject({ name: 'LocusWebError', statusCode: 402 });
    mockExecute.mockResolvedValue({ success: false, error: 'locus web_page_text failed: HTTP 429', errorCode: 'rate_limited' });
    await expect(new LocusExaClient().fetch({ url: 'https://example.com', ...ctx })).rejects.toMatchObject({ statusCode: 429 });
  });
});
