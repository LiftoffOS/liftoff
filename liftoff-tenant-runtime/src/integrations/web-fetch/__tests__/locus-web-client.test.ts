// The Locus web rung talks to connector-service, never to the vendor: it
// addresses the platform identity, reads the charge Locus reported off the
// wire, and stamps the result as platform-funded so billing books the row
// against the customer's Operating Units at the call's real cost. An empty
// balance is a 402 whatever wording produced it.

const mockExecute = jest.fn();
jest.mock('../../../connectors/connector-service-client', () => ({
  getConnectorServiceClient: () => ({ execute: mockExecute }),
}));

import { LocusWebClient, LocusWebError } from '../locus-web-client';

const ctx = { tenantId: 't1', traceId: 'trace1' };

beforeEach(() => jest.clearAllMocks());

describe('fetch', () => {
  it('dispatches web_page_scrape on the platform identity and maps the scrape', async () => {
    mockExecute.mockResolvedValue({
      success: true,
      result: { success: true, data: { markdown: '# Hello', metadata: { title: 'Hello', sourceURL: 'https://example.com/final', statusCode: 200 } } },
      costUsd: 0.003,
      fundingSource: 'platform_key',
    });
    const out = await new LocusWebClient().fetch({ url: 'https://example.com', ...ctx });
    expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({
      tenantContext: { tenantId: 't1' },
      connectorId: 'internal:locus',
      functionName: 'web_page_scrape',
      input: { url: 'https://example.com', formats: ['markdown'], onlyMainContent: true },
      idempotencyKey: expect.stringMatching(/^[0-9a-f-]{36}$/),
      traceId: 'trace1',
    }));
    expect(out).toEqual({
      content: '# Hello',
      finalUrl: 'https://example.com/final',
      vendor: 'locus_web',
      costMicros: 3_000,
      jsRendered: true,
      funding: 'platform',
    });
  });

  it('passes a settle wait through and defaults the final URL to the request', async () => {
    mockExecute.mockResolvedValue({ success: true, result: { data: { markdown: 'body' } }, costUsd: 0.003 });
    const out = await new LocusWebClient().fetch({ url: 'https://example.com', waitFor: 1500, ...ctx });
    expect(mockExecute.mock.calls[0][0].input).toEqual({ url: 'https://example.com', formats: ['markdown'], onlyMainContent: true, waitFor: 1500 });
    expect(out.finalUrl).toBe('https://example.com');
  });

  it('refuses a response with no page content rather than returning an empty page', async () => {
    mockExecute.mockResolvedValue({ success: true, result: { success: true, data: { metadata: { statusCode: 200 } } }, costUsd: 0.003 });
    await expect(new LocusWebClient().fetch({ url: 'https://example.com', ...ctx }))
      .rejects.toMatchObject({ name: 'LocusWebError', statusCode: 502 });
  });
});

describe('search', () => {
  it('dispatches web_search_results within the vendor ceiling and maps results', async () => {
    mockExecute.mockResolvedValue({
      success: true,
      result: { success: true, data: [{ url: 'https://a', title: 'A', description: 'da' }, { link: 'https://b', snippet: 'sb' }, { title: 'no url' }] },
      costUsd: 0.00466,
      fundingSource: 'platform_key',
    });
    const out = await new LocusWebClient().search({ query: 'q', maxResults: 100 }, ctx);
    expect(mockExecute.mock.calls[0][0]).toMatchObject({ functionName: 'web_search_results', input: { query: 'q', limit: 20 } });
    expect(out).toEqual({
      results: [{ url: 'https://a', title: 'A', snippet: 'da' }, { url: 'https://b', title: 'https://b', snippet: 'sb' }],
      vendor: 'locus_web',
      costMicros: 4_660,
      funding: 'platform',
    });
  });

  it('reads the v2 shape with results under data.web', async () => {
    mockExecute.mockResolvedValue({ success: true, result: { data: { web: [{ url: 'https://w', title: 'W' }] } }, costUsd: 0.005 });
    const out = await new LocusWebClient().search({ query: 'q' }, ctx);
    expect(out.results).toEqual([{ url: 'https://w', title: 'W' }]);
  });
});

describe('extract', () => {
  it('is a scrape in the json format, one round trip, the object read from data.json', async () => {
    mockExecute.mockResolvedValue({ success: true, result: { success: true, data: { json: { price: 9.99 }, metadata: { sourceURL: 'https://example.com', statusCode: 200 } } }, costUsd: 0.004192, fundingSource: 'platform_key' });
    const out = await new LocusWebClient().extract({ url: 'https://example.com', prompt: 'the price', schema: { type: 'object' }, ...ctx } as never);
    expect(mockExecute.mock.calls[0][0]).toMatchObject({
      functionName: 'web_page_scrape',
      input: { url: 'https://example.com', formats: ['json'], onlyMainContent: true, jsonOptions: { schema: { type: 'object' }, prompt: 'the price' } },
    });
    expect(out).toEqual({ data: { price: 9.99 }, finalUrl: 'https://example.com', vendor: 'locus_web', costMicros: 4_192, jsRendered: true, funding: 'platform' });
  });

  it('hands back an absent extraction as undefined data, for the router to treat as a miss', async () => {
    mockExecute.mockResolvedValue({ success: true, result: { success: true, data: { metadata: {} } }, costUsd: 0.004 });
    const out = await new LocusWebClient().extract({ url: 'https://example.com', schema: {}, ...ctx } as never);
    expect(out.data).toBeUndefined();
  });
});

describe('refusals', () => {
  it('reads an empty Locus balance as a 402, whatever wording connector-service used', async () => {
    for (const error of [
      'locus web_page_scrape failed: HTTP 402 payment required: insufficient credits (needs 3 credits, has 0)',
      'locus credential is not provisioned (no platform key)',
    ]) {
      mockExecute.mockResolvedValue({ success: false, error, errorCode: 'vendor_error' });
      await expect(new LocusWebClient().fetch({ url: 'https://example.com', ...ctx }))
        .rejects.toMatchObject({ name: 'LocusWebError', statusCode: 402 });
    }
  });

  it('maps an unavailable vendor to 503, a rate limit to 429, anything else to 400', async () => {
    const cases: Array<[string | undefined, number]> = [['vendor_unavailable', 503], ['rate_limited', 429], ['vendor_error', 400], [undefined, 400]];
    for (const [errorCode, status] of cases) {
      mockExecute.mockResolvedValue({ success: false, error: 'locus web_page_scrape failed: HTTP 500 upstream', errorCode });
      await expect(new LocusWebClient().fetch({ url: 'https://example.com', ...ctx })).rejects.toMatchObject({ statusCode: status });
    }
  });

  it('wraps a transport failure as a network error (status 0)', async () => {
    mockExecute.mockRejectedValue(new Error('connector-service unreachable'));
    const err = await new LocusWebClient().fetch({ url: 'https://example.com', ...ctx }).catch((e) => e);
    expect(err).toBeInstanceOf(LocusWebError);
    expect(err.statusCode).toBe(0);
    expect(err.message).toMatch(/connector-service unreachable/);
  });
});
