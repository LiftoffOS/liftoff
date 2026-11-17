// The x402 Browserbase rung talks to connector-service, never to the vendor:
// it addresses the platform identity, reads the settled amount off the wire,
// and stamps the wallet as the funding so billing books the row under the
// wallet-funded bucket. A refusal to pay is a 402 whatever produced it.

const mockExecute = jest.fn();
jest.mock('../../../connectors/connector-service-client', () => ({
  getConnectorServiceClient: () => ({ execute: mockExecute }),
}));

import { BrowserbaseX402Client, BrowserbaseX402Error } from '../browserbase-x402-client';

const ctx = { tenantId: 't1', traceId: 'trace1' };

beforeEach(() => jest.clearAllMocks());

describe('fetch', () => {
  it('dispatches fetch_page_content on the platform identity and maps the receipt', async () => {
    mockExecute.mockResolvedValue({
      success: true,
      result: { content: '# Hello', contentType: 'text/markdown', url: 'https://example.com/final', status: 200 },
      costUsd: 0.01,
      fundingSource: 'x402_wallet',
    });
    const out = await new BrowserbaseX402Client().fetch({ url: 'https://example.com', ...ctx });
    expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({
      tenantContext: { tenantId: 't1' },
      connectorId: 'internal:browserbase_x402',
      functionName: 'fetch_page_content',
      input: { url: 'https://example.com', allowRedirects: true },
      traceId: 'trace1',
    }));
    expect(out).toEqual({
      content: '# Hello',
      finalUrl: 'https://example.com/final',
      vendor: 'browserbase_x402',
      costMicros: 10_000,
      jsRendered: false,
      funding: 'x402_wallet',
    });
  });

  it('converts an HTML body to markdown, the way every browser client does', async () => {
    // The gateway's real shape: statusCode/headers/contentType, body raw under content.
    mockExecute.mockResolvedValue({
      success: true,
      result: { id: 'x', statusCode: 200, contentType: 'text/html', encoding: 'utf-8', content: '<!doctype html><html><body><h1>Example Domain</h1><p>Some text.</p></body></html>' },
      costUsd: 0.01,
      fundingSource: 'x402_wallet',
    });
    const out = await new BrowserbaseX402Client().fetch({ url: 'https://example.com', ...ctx });
    expect(out.content).not.toMatch(/<h1>|<body>/);
    expect(out.content).toMatch(/Example Domain/);
    expect(out.content).toMatch(/Some text\./);
    expect(out.finalUrl).toBe('https://example.com');
  });

  it('reads the page under `data` and defaults the final URL to the request', async () => {
    mockExecute.mockResolvedValue({ success: true, result: { data: { markdown: 'body' } }, costUsd: 0.01 });
    const out = await new BrowserbaseX402Client().fetch({ url: 'https://example.com', ...ctx });
    expect(out.content).toBe('body');
    expect(out.finalUrl).toBe('https://example.com');
  });

  it('refuses a response with no page content rather than returning an empty page', async () => {
    mockExecute.mockResolvedValue({ success: true, result: { status: 200 }, costUsd: 0.01 });
    await expect(new BrowserbaseX402Client().fetch({ url: 'https://example.com', ...ctx }))
      .rejects.toMatchObject({ name: 'BrowserbaseX402Error', statusCode: 502 });
  });
});

describe('search', () => {
  it('dispatches search_the_web within the gateway ceiling and maps results', async () => {
    mockExecute.mockResolvedValue({
      success: true,
      result: { requestId: 'r1', query: 'q', results: [{ id: 'https://a', title: 'A', url: 'https://a', snippet: 'sa', image: 'i', favicon: 'f' }, { link: 'https://b', description: 'db' }, { title: 'no url' }] },
      costUsd: 0.01,
      fundingSource: 'x402_wallet',
    });
    const out = await new BrowserbaseX402Client().search({ query: 'q', maxResults: 100 }, ctx);
    expect(mockExecute).toHaveBeenCalledWith(expect.objectContaining({
      functionName: 'search_the_web',
      input: { query: 'q', numResults: 25 },
    }));
    expect(out.results).toEqual([
      { url: 'https://a', title: 'A', snippet: 'sa' },
      { url: 'https://b', title: 'https://b', snippet: 'db' },
    ]);
    expect(out.vendor).toBe('browserbase_x402');
    expect(out.costMicros).toBe(10_000);
    expect(out.funding).toBe('x402_wallet');
  });

  it('defaults to ten results and reads a list under `data`', async () => {
    mockExecute.mockResolvedValue({ success: true, result: { data: [{ url: 'https://c', title: 'C' }] }, costUsd: 0 });
    const out = await new BrowserbaseX402Client().search({ query: 'q' }, ctx);
    expect(mockExecute.mock.calls[0][0].input).toEqual({ query: 'q', numResults: 10 });
    expect(out.results).toEqual([{ url: 'https://c', title: 'C' }]);
  });
});

describe('failures', () => {
  it('reads a refusal to pay as 402', async () => {
    mockExecute.mockResolvedValue({ success: false, error: 'browserbase_x402 search_the_web failed: x402 payment refused: the vendor daily ceiling is reached', errorCode: 'internal_error' });
    await expect(new BrowserbaseX402Client().search({ query: 'q' }, ctx))
      .rejects.toMatchObject({ statusCode: 402 });
  });

  it('reads an unfunded or unconfigured wallet as 402', async () => {
    mockExecute.mockResolvedValue({ success: false, error: 'x402 wallet_not_configured', errorCode: '' });
    await expect(new BrowserbaseX402Client().fetch({ url: 'https://example.com', ...ctx }))
      .rejects.toMatchObject({ statusCode: 402 });
  });

  it('maps the wire-classified codes and leaves the rest as a caller-side failure', async () => {
    const client = new BrowserbaseX402Client();
    mockExecute.mockResolvedValueOnce({ success: false, error: 'down', errorCode: 'vendor_unavailable' });
    await expect(client.search({ query: 'q' }, ctx)).rejects.toMatchObject({ statusCode: 503 });
    mockExecute.mockResolvedValueOnce({ success: false, error: 'slow down', errorCode: 'rate_limited' });
    await expect(client.search({ query: 'q' }, ctx)).rejects.toMatchObject({ statusCode: 429 });
    mockExecute.mockResolvedValueOnce({ success: false, error: 'HTTP 400 bad url', errorCode: 'invalid_arguments' });
    await expect(client.search({ query: 'q' }, ctx)).rejects.toMatchObject({ statusCode: 400 });
  });

  it('reads a thrown transport error as status 0', async () => {
    mockExecute.mockRejectedValue(new Error('unavailable'));
    const err = await new BrowserbaseX402Client().search({ query: 'q' }, ctx).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BrowserbaseX402Error);
    expect((err as BrowserbaseX402Error).statusCode).toBe(0);
  });
});
