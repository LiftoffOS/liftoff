// The Locus rung: one metered POST on the platform key with an idempotency
// key, the charge read off the response headers and booked as platform-funded
// cost (the listed price only if Locus reports none), an empty balance worded
// as payment required so the capability path parks the rung, and a provider
// refusal surfaced as the vendor worded it.

import type { ExecutorContext } from '../rpc/execute-dispatcher.js';

const calls: Array<{ url: string; headers: Record<string, string>; reqHeaders: Record<string, string>; body: unknown }> = [];
let script: Array<{ status: number; body: unknown; headers?: Record<string, string> }> = [];
jest.mock('./connector-transport.js', () => ({
  DEFAULT_PUBLIC_WEB_HEADERS: { 'User-Agent': 'test' },
  makePublicWebTransport: (_type: string, headers: Record<string, string>) => async (req: { url: string; headers?: Record<string, string>; body?: unknown }) => {
    calls.push({ url: req.url, headers, reqHeaders: req.headers ?? {}, body: req.body });
    const next = script.shift() ?? { status: 500, body: {} };
    return { ok: next.status < 400, status: next.status, headers: new Headers(next.headers ?? {}), json: async () => next.body } as unknown as Response;
  },
}));
jest.mock('../infra/logging.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { locusExecutor, locusCall, locusBalanceUsd, LocusRefusal } from './locus.js';

function ctx(functionName: string, input: Record<string, unknown>): ExecutorContext {
  return {
    tenantId: 't-1', connectorId: 'internal:locus', connectorType: 'locus', connectorConfig: {},
    functionName, input: input as ExecutorContext['input'], idempotencyKey: 'idem-7', traceId: 'tr',
    credentials: { flowKind: 'api_key' },
  } as ExecutorContext;
}

beforeEach(() => { calls.length = 0; script = []; process.env.LOCUS_API_KEY = 'lcr_test'; });
afterAll(() => { delete process.env.LOCUS_API_KEY; });

it('posts the provider body to the wrapped slug with the key and the idempotency key, and books the charge off the headers', async () => {
  script = [{ status: 200, body: { people: [{ title: 'CFO' }], total_entries: 1 }, headers: { 'x-locus-credits-charged': '2.02', 'x-locus-cost-usd': '0.002020', 'x-locus-credits-balance': '23775.88', 'x-locus-api-call-id': 'call-1' } }];
  const out = await locusExecutor(ctx('people_search', { person_titles: ['CFO'], q_organization_domains_list: ['shopify.com'], per_page: 1 }));
  expect(out.failure).toBeUndefined();
  expect(out.result).toEqual({ people: [{ title: 'CFO' }], total_entries: 1 });
  expect(out.costUsd).toBeCloseTo(0.00202, 9);
  expect(out.fundingSource).toBe('platform_key');
  expect(calls[0].url).toBe('https://api.paywithlocus.com/api/wrapped/credits/apollo/people-search');
  expect(calls[0].headers.Authorization).toBe('Bearer lcr_test');
  expect(calls[0].reqHeaders['Idempotency-Key']).toBe('idem-7');
  expect(calls[0].body).toEqual({ person_titles: ['CFO'], q_organization_domains_list: ['shopify.com'], per_page: 1 });
});

it('a caller that sent no idempotency key still reaches Locus, under a key of the call\'s own', async () => {
  script = [{ status: 200, body: { success: true, data: { markdown: '# Example' } }, headers: { 'x-locus-cost-usd': '0.003000' } }];
  const out = await locusExecutor({ ...ctx('web_page_scrape', { url: 'https://example.com' }), idempotencyKey: '' } as ExecutorContext);
  expect(out.failure).toBeUndefined();
  expect(calls[0].reqHeaders['Idempotency-Key']).toMatch(/^[0-9a-f-]{36}$/);
  expect(out.costUsd).toBeCloseTo(0.003, 9);
});

it('a pass-through function forwards the vendor path and the input as the query, and books the quoted charge', async () => {
  script = [{ status: 200, body: { status: 200, likelihood: 9, data: { full_name: 'Jeff Hoffmeister', job_title: 'CFO' } }, headers: { 'x-locus-cost-usd': '0.280000', 'x-locus-credits-charged': '280' } }];
  const out = await locusExecutor(ctx('person_profile_enrich', { profile: 'https://linkedin.com/in/jeff-hoffmeister-2b028310' }));
  expect(out.failure).toBeUndefined();
  expect(calls[0].url).toBe('https://api.paywithlocus.com/api/wrapped/credits/mpp-orth-peopledatalabs/call');
  expect(calls[0].body).toEqual({ _method: 'GET', _path: '/v5/person/enrich', _query: { profile: 'https://linkedin.com/in/jeff-hoffmeister-2b028310' } });
  expect(out.costUsd).toBeCloseTo(0.28, 9);
  expect(out.result).toMatchObject({ data: { job_title: 'CFO' } });
  script = [{ status: 200, body: { profile: { email: ['a@b.co'] } }, headers: { 'x-locus-cost-usd': '0.1' } }];
  await locusExecutor(ctx('linkedin_contact_details', { profile: 'https://linkedin.com/in/x', include_phone: false }));
  expect(calls[1].body).toEqual({ _method: 'GET', _path: '/v1/people/linkedin', _query: { profile: 'https://linkedin.com/in/x', include_phone: false } });
});

it('falls back to credits, then to the listed price, when the USD header is missing', async () => {
  script = [{ status: 200, body: { email: 'a@b.co' }, headers: { 'x-locus-credits-charged': '13' } }];
  expect((await locusExecutor(ctx('email_find', { domain: 'b.co', first_name: 'A' }))).costUsd).toBeCloseTo(0.013, 9);
  script = [{ status: 200, body: { email: 'a@b.co' } }];
  expect((await locusExecutor(ctx('email_find', { domain: 'b.co', first_name: 'A' }))).costUsd).toBeCloseTo(0.013, 9);
});

it('a web function posts the provider body to the Firecrawl slug and books the quoted charge', async () => {
  script = [{ status: 200, body: { success: true, data: { markdown: '# Hi', metadata: { title: 'Hi' } } }, headers: { 'x-locus-cost-usd': '0.003000' } }];
  const out = await locusExecutor(ctx('web_page_scrape', { url: 'https://example.com', formats: ['markdown'] }));
  expect(out.failure).toBeUndefined();
  expect(calls[0].url).toBe('https://api.paywithlocus.com/api/wrapped/credits/firecrawl/scrape');
  expect(calls[0].body).toEqual({ url: 'https://example.com', formats: ['markdown'] });
  expect(out.costUsd).toBeCloseTo(0.003, 9);
  expect(out.result).toMatchObject({ data: { markdown: '# Hi' } });
});

it('the page-text overflow posts the vendor body to the Exa x402 slug and books the charge Locus reports', async () => {
  script = [{ status: 200, body: { requestId: 'r1', results: [{ id: 'https://example.com', url: 'https://example.com', title: 'Example Domain', text: 'Example Domain\n\nThis domain…' }], costDollars: { total: 0.001 } }, headers: { 'x-locus-cost-usd': '0.001000', 'x-locus-credits-charged': '1' } }];
  const out = await locusExecutor(ctx('web_page_text', { urls: ['https://example.com'], text: true }));
  expect(out.failure).toBeUndefined();
  expect(calls[0].url).toBe('https://api.paywithlocus.com/api/wrapped/credits/x402-api-exa-ai-contents/call');
  expect(calls[0].body).toEqual({ urls: ['https://example.com'], text: true });
  expect(out.costUsd).toBeCloseTo(0.001, 9);
  expect(out.fundingSource).toBe('platform_key');
  expect(out.result).toMatchObject({ results: [{ url: 'https://example.com', text: expect.stringContaining('Example Domain') }] });
});

it('a startup function posts the vendor body to the Crunchbase Parse slug and books the fixed charge', async () => {
  script = [{ status: 200, body: { status: 'success', data: { count: 1, entities: [{ uuid: '6f83ddd7-d637-61f8-06b2-438a0037605f', properties: { identifier: { permalink: 'stripe', value: 'Stripe' } } }] } }, headers: { 'x-locus-cost-usd': '0.050500', 'x-locus-credits-charged': '50.5' } }];
  const out = await locusExecutor(ctx('startup_search', { query: 'stripe', limit: 5 }));
  expect(out.failure).toBeUndefined();
  expect(calls[0].url).toBe('https://api.paywithlocus.com/api/wrapped/credits/parse-crunchbase-com-api-08842cc1/search_organizations');
  expect(calls[0].body).toEqual({ query: 'stripe', limit: 5 });
  expect(out.costUsd).toBeCloseTo(0.0505, 9);
  expect(out.result).toMatchObject({ data: { count: 1 } });
});

it('a market function posts the vendor body to the Yahoo Finance Parse slug and books the charge Locus reports', async () => {
  script = [{ status: 200, body: { status: 'success', data: { ticker: 'SPY', holdings: [{ symbol: 'NVDA', weight: 7.9 }] } }, headers: { 'x-locus-cost-usd': '0.025250', 'x-locus-credits-charged': '25.25' } }];
  const out = await locusExecutor(ctx('fund_top_holdings', { ticker: 'SPY' }));
  expect(out.failure).toBeUndefined();
  expect(calls[0].url).toBe('https://api.paywithlocus.com/api/wrapped/credits/parse-finance-yahoo-com-api-9d24fafd/get_holdings');
  expect(calls[0].body).toEqual({ ticker: 'SPY' });
  expect(out.costUsd).toBeCloseTo(0.02525, 9);
  expect(out.result).toMatchObject({ data: { ticker: 'SPY' } });
});

it('a currency read posts the symbol to the free lane and books what the source charged, which is nothing', async () => {
  // A live answer. `note` upsells a paid realtime feed and
  // `free` restates the price; the rate, its timestamp and its source stay.
  script = [{ status: 200, body: {
    symbol: 'EUR-USD', category: 'fx', price: 1.13724, publishTime: 1790614331,
    timestamp: '2026-09-28T16:52:11.000Z', assetType: 'fx', source: 'chainlink', realtime: false,
    note: 'Daily close, not realtime. Realtime feeds and full global coverage are available on request - contact us.',
    free: true,
  }, headers: { 'x-locus-cost-usd': '0.000000', 'x-locus-credits-charged': '0' } }];
  const out = await locusExecutor(ctx('currency_daily_exchange_rate', { symbol: 'EUR-USD' }));
  expect(out.failure).toBeUndefined();
  expect(calls[0].url).toBe('https://api.paywithlocus.com/api/wrapped/credits/x402-blockrun-fx-price-symbol/call');
  expect(calls[0].body).toEqual({ symbol: 'EUR-USD' });
  expect(out.costUsd).toBe(0);
  expect(out.result).toEqual({
    symbol: 'EUR-USD', category: 'fx', price: 1.13724, publishTime: 1790614331,
    timestamp: '2026-09-28T16:52:11.000Z', assetType: 'fx', source: 'chainlink', realtime: false,
  });
  // `realtime: false` is kept on purpose: it is true of the reading, and a
  // model that cannot see it would read a daily close as a live quote.
  expect(out.result).toHaveProperty('realtime', false);
});

it('a symbol the free feed does not carry is a refusal, and says so without naming the supplier', async () => {
  // Measured: the feed answers only EUR/GBP/AUD against USD, gold and silver.
  // Everything else — the crosses, JPY, CAD, CHF, platinum, the base metals —
  // comes back 424 `owned_read_unavailable`. Locus's own status, so the typed
  // refusal already covers it; what matters is that it stays a failure and the
  // wording carries no vendor.
  script = [{ status: 424, body: { success: false, code: 'owned_read_unavailable', message: 'The free owned result could not be retrieved. Retry with a fresh idempotency key.' } }];
  const out = await locusExecutor(ctx('currency_daily_exchange_rate', { symbol: 'USD-JPY' }));
  expect(out.result).toEqual({});
  expect(out.failure?.message).toContain('locus currency_daily_exchange_rate failed');
  expect(out.failure?.message).not.toMatch(/blockrun|pyth|chainlink/i);
});

it("strips the supplier's catalogue envelope, which carries its name and its mailbox", async () => {
  // Live shape of the free lane: the symbol list arrives
  // wrapped in route templates, a prose note in the supplier's voice and a
  // support address. A model reading that learns who answered.
  script = [{ status: 200, body: {
    category: 'stocks/us', label: 'US Stock', count: 100, example: 'AAPL',
    endpoints: { realtime: '/v1/stocks/us/price/{symbol}' },
    available: false,
    note: 'We do not currently serve equity prices. Contact us.',
    contact: 'hello@some-supplier.example',
    symbols: [{ symbol: 'AAPL', description: 'APPLE INC / US DOLLAR' }],
  }, headers: { 'x-locus-cost-usd': '0.000000' } }];
  const out = await locusExecutor(ctx('us_stock_symbols', {}));
  // A DIRECTORY read still succeeds: the symbol list is its own answer and the
  // flag is about the price routes it documents, not about itself.
  expect(out.failure).toBeUndefined();
  expect(out.result).toEqual({
    category: 'stocks/us', label: 'US Stock', count: 100, example: 'AAPL',
    symbols: [{ symbol: 'AAPL', description: 'APPLE INC / US DOLLAR' }],
  });
  const serialised = JSON.stringify(out.result);
  for (const leak of ['endpoints', 'contact', 'note', 'available', 'some-supplier']) {
    expect(serialised).not.toContain(leak);
  }
});

it('refuses a figure read the source says it does not serve, rather than answering with the refusal', async () => {
  // `available: false` on a read whose whole answer is a figure is the source
  // refusing. Passing it through as a success is a fabricated success: nothing
  // retries, nothing falls through to another rung, and there is no figure.
  script = [{ status: 200, body: { symbol: 'XAU-USD', available: false, note: 'not served', contact: 'hello@some-supplier.example' }, headers: { 'x-locus-cost-usd': '0.000000' } }];
  const out = await locusExecutor(ctx('commodity_daily_price', { symbol: 'XAU-USD' }));
  expect(out.failure?.message).toBe('locus commodity_daily_price failed: the source does not currently serve this reading');
  expect(out.result).toEqual({});
  expect(JSON.stringify(out.failure)).not.toContain('some-supplier');
});

it('leaves every other rung\'s payload alone', async () => {
  // The envelope strip is scoped to the free market-data lane by slug; a
  // vendor whose own answer has a `note` or an `available` field keeps it.
  script = [{ status: 200, body: { note: 'kept', available: false, data: { ok: 1 } }, headers: { 'x-locus-cost-usd': '0.005' } }];
  const out = await locusExecutor(ctx('company_search', { q_organization_name: 'x' }));
  expect(out.failure).toBeUndefined();
  expect(out.result).toEqual({ note: 'kept', available: false, data: { ok: 1 } });
});

it('wraps a list answer so the wire stays an object', async () => {
  script = [{ status: 200, body: [{ id: 1 }], headers: { 'x-locus-cost-usd': '0.005' } }];
  expect((await locusExecutor(ctx('company_search', { q_organization_name: 'x' }))).result).toEqual({ items: [{ id: 1 }] });
});

it('words an empty balance as payment required, uncharged, so the capability path parks the rung', async () => {
  script = [{ status: 402, body: { error: 'Insufficient credits', message: 'Top up', requiredCredits: '13', availableCredits: '2' } }];
  const out = await locusExecutor(ctx('email_verify', { email: 'x@y.z' }));
  expect(out.failure?.message).toBe('locus email_verify failed: HTTP 402 payment required: insufficient credits (needs 13 credits, has 2)');
  expect(out.costUsd).toBeUndefined();
});

it("surfaces a provider refusal as the vendor worded it, and locusCall throws a typed refusal", async () => {
  script = [{ status: 422, body: { error: { message: 'domain is required', code: 'invalid_input' } } }];
  expect((await locusExecutor(ctx('domain_emails', {}))).failure?.message).toBe('locus domain_emails failed: HTTP 422 domain is required');
  script = [{ status: 403, body: { error: 'Endpoint disabled' } }];
  await expect(locusCall('apollo/org-search', {}, 'k')).rejects.toBeInstanceOf(LocusRefusal);
});

it('keeps the MESSAGE beside the category, which is the half that says what is wrong', async () => {
  // Every Zillow search outside the five cities came back as a bare "HTTP 400
  // Invalid request", because `error` is the category and `message` — the one
  // sentence naming the constraint — was dropped.
  script = [{ status: 400, body: { error: 'Invalid request', message: 'location must be one of: Austin, TX, Chicago, IL, Los Angeles, CA, New York, NY, Seattle, WA' } }];
  expect((await locusExecutor(ctx('home_listings_search_homes_for_sale', { location: 'Palo Alto, CA' }))).failure?.message)
    .toBe('locus home_listings_search_homes_for_sale failed: HTTP 400 Invalid request: location must be one of: Austin, TX, Chicago, IL, Los Angeles, CA, New York, NY, Seattle, WA');

  // A category with nothing behind it still reads as it did.
  script = [{ status: 403, body: { error: 'Endpoint disabled' } }];
  expect((await locusExecutor(ctx('email_verify', { email: 'x@y.z' }))).failure?.message)
    .toBe('locus email_verify failed: HTTP 403 Endpoint disabled');
});

it('refuses without a platform key and names an unknown tool', async () => {
  delete process.env.LOCUS_API_KEY;
  expect((await locusExecutor(ctx('email_verify', { email: 'x@y.z' }))).failure?.message).toContain('not provisioned');
  process.env.LOCUS_API_KEY = 'lcr_test';
  expect((await locusExecutor(ctx('delete_everything', {}))).failure?.message).toContain('no tool named');
  expect(calls).toHaveLength(0);
});

it('reads the prepaid balance in USD off the balance route, and reports a refusal as one', async () => {
  script = [{ status: 200, body: { usd: '23.670384', credits: '23670.384', denomination: { creditsPerDollar: 1000 } }, headers: {} }];
  expect(await locusBalanceUsd()).toBeCloseTo(23.670384, 9);
  expect(calls[calls.length - 1].url).toBe('https://api.paywithlocus.com/api/credits/balance');
  script = [{ status: 401, body: { error: 'Unauthorized' }, headers: {} }];
  await expect(locusBalanceUsd()).rejects.toThrow('HTTP 401');
});
