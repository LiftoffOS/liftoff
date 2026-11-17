// The three internal-tier data-vendor executors: dispatch fidelity, credential
// fallback, typed failures. All vendor traffic is mocked — no network.

import type { ExecutorContext } from '../../rpc/execute-dispatcher.js';
import { tikhubExecutor } from '../tikhub.js';
import { straleExecutor } from '../strale.js';
import { nasdaqExecutor } from '../nasdaq.js';
import { ycombinatorExecutor } from '../ycombinator.js';
import { TIKHUB_DISPATCH } from '../../catalog/generated/tikhub.js';
import { STRALE_DISPATCH } from '../../catalog/generated/strale.js';

const originalFetch = global.fetch;

function ctx(overrides: Partial<ExecutorContext>): ExecutorContext {
  return {
    tenantId: 't-1',
    connectorId: 'internal:test',
    connectorType: 'test',
    connectorConfig: {},
    functionName: 'missing',
    input: {},
    idempotencyKey: 'idem-1',
    traceId: 'trace-1',
    credentials: { flowKind: 'api_key' },
    ...overrides,
  };
}

function mockFetchOnce(status: number, body: unknown): jest.Mock {
  const mock = jest.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
    json: async () => body,
  });
  global.fetch = mock as unknown as typeof fetch;
  return mock;
}

afterEach(() => {
  global.fetch = originalFetch;
  delete process.env.TIKHUB_PLATFORM_API_KEY;
  delete process.env.STRALE_PLATFORM_API_KEY;
  delete process.env.NASDAQ_PLATFORM_API_KEY;
});

describe('tikhub executor', () => {
  const someGet = Object.entries(TIKHUB_DISPATCH).find(([, d]) => d.method === 'get')!;

  it('dispatches the co-generated path with query params and the tenant key', async () => {
    const mock = mockFetchOnce(200, { data: [1] });
    const out = await tikhubExecutor(
      ctx({
        connectorType: 'tikhub',
        functionName: someGet[0],
        input: { keyword: 'hello world' },
        credentials: { flowKind: 'api_key', apiKey: 'tenant-key' },
      }),
    );
    expect(out.failure).toBeUndefined();
    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toContain(`https://api.tikhub.io${someGet[1].path}`);
    expect(String(url)).toContain('keyword=hello+world');
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer tenant-key');
  });

  it('falls back to the platform key when the instance carries none', async () => {
    process.env.TIKHUB_PLATFORM_API_KEY = 'platform-key';
    const mock = mockFetchOnce(200, {});
    await tikhubExecutor(ctx({ connectorType: 'tikhub', functionName: someGet[0] }));
    const [, init] = mock.mock.calls[0];
    expect((init as { headers: Record<string, string> }).headers.Authorization).toBe('Bearer platform-key');
  });

  it('refuses with a typed failure when neither key exists', async () => {
    const out = await tikhubExecutor(ctx({ connectorType: 'tikhub', functionName: someGet[0] }));
    expect(out.failure?.message).toContain('not provisioned');
  });

  it('reports a vendor non-2xx as failure, never success', async () => {
    process.env.TIKHUB_PLATFORM_API_KEY = 'k';
    mockFetchOnce(429, { detail: 'rate limited' });
    const out = await tikhubExecutor(ctx({ connectorType: 'tikhub', functionName: someGet[0] }));
    expect(out.failure?.message).toContain('429');
  });

  it('refuses an unknown function name', async () => {
    const out = await tikhubExecutor(ctx({ connectorType: 'tikhub', functionName: 'not_a_tool' }));
    expect(out.failure?.message).toContain('no operation named');
  });

  // The vendor's 2xx envelope carries its own presentation beside the answer:
  // a docs link on its domain, a support link, a billing notice, a cache note.
  // The result is read by a model as written, and a platform vendor is never
  // named to a model, so only the answer travels.
  it('returns the answer without the vendor envelope', async () => {
    process.env.TIKHUB_PLATFORM_API_KEY = 'k';
    mockFetchOnce(200, {
      code: 200,
      router: someGet[1].path,
      params: { keyword: 'x' },
      data: { items: [{ id: '1' }] },
      request_id: 'r-1',
      message: 'Request successful. This request will incur a charge.',
      message_zh: '请求成功',
      support: 'Discord: https://discord.gg/example',
      docs: 'https://api.tikhub.io/#/docs',
      cache_message: 'This response is cached and accessible via the URL https://api.tikhub.io/cache/1',
    });
    const out = await tikhubExecutor(ctx({ connectorType: 'tikhub', functionName: someGet[0], input: { keyword: 'x' } }));
    expect(out.failure).toBeUndefined();
    expect(out.result).toEqual({
      code: 200,
      router: someGet[1].path,
      params: { keyword: 'x' },
      data: { items: [{ id: '1' }] },
    });
    expect(JSON.stringify(out.result)).not.toMatch(/tikhub|discord/i);
  });

  it('passes a body without data through whole', async () => {
    process.env.TIKHUB_PLATFORM_API_KEY = 'k';
    mockFetchOnce(200, { code: 200, items: [1, 2] });
    const out = await tikhubExecutor(ctx({ connectorType: 'tikhub', functionName: someGet[0] }));
    expect(out.result).toEqual({ code: 200, items: [1, 2] });
  });
});

describe('strale executor', () => {
  const [fnName, dispatch] = Object.entries(STRALE_DISPATCH)[0];
  const slug = dispatch.path.split('/').filter(Boolean).pop();

  it('wraps /v1/do with the slug, inputs, spend cap, and idempotency key', async () => {
    const mock = mockFetchOnce(200, {
      result: { status: 'completed', output: { ok: true }, price_cents: 3 },
    });
    const out = await straleExecutor(
      ctx({
        connectorType: 'strale',
        functionName: fnName,
        input: { query: 'x' },
        credentials: { flowKind: 'api_key', apiKey: 'tenant-key' },
      }),
    );
    expect(out.failure).toBeUndefined();
    // The vendor's own account of the charge wins over the price list.
    expect(out.costUsd).toBe(0.03);
    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toBe('https://api.strale.io/v1/do');
    const body = JSON.parse((init as { body: string }).body);
    expect(body.capability_slug).toBe(slug);
    expect(body.inputs).toEqual({ query: 'x' });
    if (typeof dispatch.priceUsd === 'number') {
      expect(body.max_price_cents).toBeGreaterThanOrEqual(10);
    }
    expect((init as { headers: Record<string, string> }).headers['Idempotency-Key']).toBe('idem-1');
  });

  it('treats error_code as failure', async () => {
    process.env.STRALE_PLATFORM_API_KEY = 'k';
    mockFetchOnce(200, { error_code: 'insufficient_funds', message: 'top up' });
    const out = await straleExecutor(ctx({ connectorType: 'strale', functionName: fnName }));
    expect(out.failure?.message).toContain('insufficient_funds');
  });

  it("labels internal-path funding as the PLATFORM's, whatever rides in credentials", async () => {
    // The dispatcher puts the platform key INSIDE credentials on the
    // `internal:` path (so it joins the secret scrub); the funding stamp
    // must not read that as a tenant key.
    mockFetchOnce(200, { result: { status: 'completed', output: {}, price_cents: 2 } });
    const out = await straleExecutor(ctx({
      connectorId: 'internal:strale',
      connectorType: 'strale',
      functionName: fnName,
      credentials: { flowKind: 'api_key', apiKey: 'platform-key-in-band' },
    }));
    expect(out.failure).toBeUndefined();
    expect(out.fundingSource).toBe('platform_key');
  });

  it("labels a real instance's own key as the TENANT's money", async () => {
    mockFetchOnce(200, { result: { status: 'completed', output: {}, price_cents: 2 } });
    const out = await straleExecutor(ctx({
      connectorId: 'conn-strale-tenant-1',
      connectorType: 'strale',
      functionName: fnName,
      credentials: { flowKind: 'api_key', apiKey: 'tenant-key' },
    }));
    expect(out.failure).toBeUndefined();
    expect(out.fundingSource).toBe('tenant_key');
  });

  it('treats a non-completed status as failure', async () => {
    process.env.STRALE_PLATFORM_API_KEY = 'k';
    mockFetchOnce(200, { result: { status: 'failed', output: null } });
    const out = await straleExecutor(ctx({ connectorType: 'strale', functionName: fnName }));
    expect(out.failure?.message).toContain('failed');
  });
});

describe('nasdaq market-data executor', () => {
  const OK = (data: unknown) => ({ data, message: null, status: { rCode: 200, bCodeMessage: null } });

  it('routes a quote to api.nasdaq.com with the asset class and NO Authorization header', async () => {
    const mock = mockFetchOnce(200, OK({ symbol: 'AAPL', primaryData: { lastSalePrice: '$1' } }));
    const out = await nasdaqExecutor(
      ctx({ connectorType: 'nasdaq', functionName: 'get_stock_quote', input: { symbol: 'aapl' } }),
    );
    expect(out.failure).toBeUndefined();
    expect(out.costUsd).toBe(0);
    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toContain('https://api.nasdaq.com/api/quote/AAPL/info');
    expect(String(url)).toContain('assetclass=stocks');
    // Keyless public API: a bearer must never be sent, and browser headers must.
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['User-Agent']).toMatch(/Mozilla/);
  });

  it('serves news from the www.nasdaq.com host with a SYMBOL|assetclass filter', async () => {
    const mock = mockFetchOnce(200, OK({ rows: [] }));
    await nasdaqExecutor(
      ctx({ connectorType: 'nasdaq', functionName: 'get_stock_news', input: { symbol: 'AAPL', limit: 3 } }),
    );
    const url = String(mock.mock.calls[0][0]);
    expect(url).toContain('https://www.nasdaq.com/api/news/topic/articlebysymbol');
    expect(url).toContain('q=AAPL%7Cstocks');
  });

  it('refuses a symbol outside the ticker alphabet (no path traversal)', async () => {
    const out = await nasdaqExecutor(
      ctx({ connectorType: 'nasdaq', functionName: 'get_stock_quote', input: { symbol: '../secrets' } }),
    );
    expect(out.failure?.message).toContain('symbol is required');
  });

  it('reads failure off the envelope rCode, not the HTTP status', async () => {
    // The vendor answers a bad request with HTTP 200 + rCode 400.
    mockFetchOnce(200, { data: null, status: { rCode: 400, bCodeMessage: [{ errorMessage: 'search is empty' }] } });
    const out = await nasdaqExecutor(
      ctx({ connectorType: 'nasdaq', functionName: 'search_symbols', input: { query: 'x' } }),
    );
    expect(out.failure?.message).toContain('rCode 400');
    expect(out.failure?.message).toContain('search is empty');
  });

  it('reports a 403 bot-challenge as unavailable, never as a permissions problem', async () => {
    mockFetchOnce(403, {});
    const out = await nasdaqExecutor(
      ctx({ connectorType: 'nasdaq', functionName: 'get_stock_quote', input: { symbol: 'AAPL' } }),
    );
    expect(out.failure?.message).toContain('unavailable');
    expect(out.failure?.message).not.toMatch(/forbidden|permission/i);
  });

  it('treats an HTML (non-JSON) body as an edge block, not a crash', async () => {
    const mock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token < in JSON'); },
    });
    global.fetch = mock as unknown as typeof fetch;
    const out = await nasdaqExecutor(
      ctx({ connectorType: 'nasdaq', functionName: 'get_market_info', input: {} }),
    );
    expect(out.failure?.message).toContain('unavailable');
  });
});

describe('ycombinator directory executor', () => {
  const page = (companies: unknown[], p = 1, totalPages = 1) => ({ companies, page: p, totalPages, nextPage: p < totalPages ? `x?page=${p + 1}` : null });

  it('searches the directory with the filters the API takes, keyless, free, and booked as nothing', async () => {
    const mock = mockFetchOnce(200, page([{ slug: 'stripe', name: 'Stripe', batch: 'S09' }]));
    const out = await ycombinatorExecutor(
      ctx({ connectorType: 'ycombinator', functionName: 'yc_companies_search', input: { query: 'payments', batch: 'S09', industry: 'Fintech', status: 'Active', page: 2 } }),
    );
    expect(out.failure).toBeUndefined();
    expect(out.costUsd).toBe(0);
    expect(out.fundingSource).toBe('platform_key');
    expect(out.result).toEqual({ companies: [{ slug: 'stripe', name: 'Stripe', batch: 'S09' }], page: 1, totalPages: 1 });
    const [url, init] = mock.mock.calls[0];
    expect(String(url)).toBe('https://api.ycombinator.com/v0.1/companies?q=payments&batch=S09&industry=Fintech&status=Active&page=2');
    const headers = (init as { headers: Record<string, string> }).headers;
    expect(headers.Authorization).toBeUndefined();
    expect(headers['User-Agent']).toMatch(/Mozilla/);
  });

  it('a profile by slug is the exact slug picked out of a fuzzy search, not the first row', async () => {
    mockFetchOnce(200, page([{ slug: 'stripe-atlas', name: 'Stripe Atlas' }, { slug: 'stripe', name: 'Stripe', batch: 'S09' }]));
    const out = await ycombinatorExecutor(ctx({ connectorType: 'ycombinator', functionName: 'yc_company_profile', input: { slug: 'Stripe' } }));
    expect(out.failure).toBeUndefined();
    expect(out.result).toEqual({ company: { slug: 'stripe', name: 'Stripe', batch: 'S09' } });
  });

  it('reads on through the first pages for the slug and reports a miss as one', async () => {
    const mock = jest.fn()
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => page([{ slug: 'other' }], 1, 2) })
      .mockResolvedValueOnce({ ok: true, status: 200, json: async () => page([{ slug: 'nope' }], 2, 2) });
    global.fetch = mock as unknown as typeof fetch;
    const out = await ycombinatorExecutor(ctx({ connectorType: 'ycombinator', functionName: 'yc_company_profile', input: { slug: 'ghost-co' } }));
    expect(mock).toHaveBeenCalledTimes(2);
    expect(out.failure?.message).toContain("no company in the directory has the slug 'ghost-co'");
  });

  it('refuses a slug outside the directory alphabet and names an unknown tool', async () => {
    expect((await ycombinatorExecutor(ctx({ connectorType: 'ycombinator', functionName: 'yc_company_profile', input: { slug: '../x' } }))).failure?.message).toContain('needs a company slug');
    expect((await ycombinatorExecutor(ctx({ connectorType: 'ycombinator', functionName: 'delete_everything', input: {} }))).failure?.message).toContain('no tool named');
  });

  it('reports an upstream refusal as a failure with nothing booked', async () => {
    mockFetchOnce(503, {});
    const out = await ycombinatorExecutor(ctx({ connectorType: 'ycombinator', functionName: 'yc_companies_search', input: { query: 'x' } }));
    expect(out.failure?.message).toContain('HTTP 503');
    expect(out.costUsd).toBeUndefined();
  });
});
