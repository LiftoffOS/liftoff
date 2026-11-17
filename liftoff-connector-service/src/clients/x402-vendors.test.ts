// The x402 pay-per-call vendor executors: transport choice, declared-price
// caps, receipt-derived costUsd, and strale's keyless x402 fallback lane.
// The transports are mocked — no network, no payments.

import type { ExecutorContext } from '../rpc/execute-dispatcher.js';

const PAID_HEADER = 'x-x402-paid-usd';
const TX_HEADER = 'x-x402-transaction';

interface CapturedCall {
  connectorType: string;
  declaredPriceUsd?: number;
  req?: { method: string; url: string; query?: Record<string, string>; body?: unknown };
}
const captured: CapturedCall[] = [];
const vendorAnswer = {
  status: 200,
  body: {} as unknown,
  paidUsd: 0.03 as number | null,
};

function fakeResponse(): Response {
  const headers: Record<string, string> = vendorAnswer.paidUsd === null
    ? {}
    : { [PAID_HEADER]: vendorAnswer.paidUsd.toFixed(6), [TX_HEADER]: '0xtx' };
  return {
    ok: vendorAnswer.status >= 200 && vendorAnswer.status < 300,
    status: vendorAnswer.status,
    headers: { get: (h: string) => headers[h.toLowerCase()] ?? null },
    json: async () => vendorAnswer.body,
  } as unknown as Response;
}

/** The key lane's transport: records the bearer and answers a completed /v1/do. */
const keyLaneCalls: Array<{ accessToken?: string; url?: string }> = [];
jest.mock('./connector-transport.js', () => ({
  makeConnectorTransport: (creds: { accessToken?: string }) => async (req: { url: string }) => {
    keyLaneCalls.push({ accessToken: creds.accessToken, url: req.url });
    return {
      ok: true, status: 200,
      json: async () => ({ result: { status: 'completed', output: { via: 'key' }, price_cents: 3 } }),
    } as unknown as Response;
  },
  X402_PAID_USD_HEADER: 'x-x402-paid-usd',
  X402_TRANSACTION_HEADER: 'x-x402-transaction',
  readX402Receipt: (r: Response) => {
    const paid = r.headers.get('x-x402-paid-usd');
    if (paid === null) return undefined;
    const amountUsd = Number(paid);
    if (!Number.isFinite(amountUsd)) return undefined;
    return { amountUsd, transaction: r.headers.get('x-x402-transaction') ?? undefined };
  },
  makeX402Transport: (connectorType: string, opts?: { declaredPriceUsd?: number }) => {
    const call: CapturedCall = { connectorType, declaredPriceUsd: opts?.declaredPriceUsd };
    captured.push(call);
    return async (req: CapturedCall['req']) => {
      call.req = req;
      return fakeResponse();
    };
  },
}));

const platformKeyMock = jest.fn((_connectorType: string): string | undefined => undefined);
jest.mock('./platform-vendor-keys.js', () => ({
  resolvePlatformVendorKey: (t: string) => platformKeyMock(t),
  // Real implementation: the funding label logic under test depends on it.
  tenantOwnApiKey: jest.requireActual('./platform-vendor-keys.js').tenantOwnApiKey,
}));

const isX402ConfiguredMock = jest.fn(() => true);
jest.mock('../x402/wallet.js', () => ({
  isX402Configured: () => isX402ConfiguredMock(),
}));

import { googleTrendsExecutor } from './google-trends.js';
import { browserbaseX402Executor } from './browserbase-x402.js';
import { kadec0Executor } from './kadec0.js';
import { straleExecutor } from './strale.js';

function ctx(connectorType: string, functionName: string, input: Record<string, unknown>): ExecutorContext {
  return {
    tenantId: 't-1', connectorId: `internal:${connectorType}`, connectorType,
    connectorConfig: {}, functionName, input: input as ExecutorContext['input'],
    idempotencyKey: 'idem-1', traceId: 'tr', credentials: { flowKind: 'api_key' },
  };
}

beforeEach(() => {
  captured.length = 0;
  keyLaneCalls.length = 0;
  platformKeyMock.mockReturnValue(undefined);
  vendorAnswer.status = 200;
  vendorAnswer.body = {};
  vendorAnswer.paidUsd = 0.03;
  isX402ConfiguredMock.mockReturnValue(true);
});

describe('google_trends executor', () => {
  it('GETs the tool path with the inputs as query and books the receipt', async () => {
    vendorAnswer.body = { keyword: 'bitcoin', series: [] };
    const out = await googleTrendsExecutor(ctx('google_trends', 'get_keyword_trend', { keyword: 'bitcoin' }));
    expect(out.failure).toBeUndefined();
    expect(out.costUsd).toBeCloseTo(0.03, 9);
    expect(out.fundingSource).toBe('x402_wallet');
    const call = captured[0];
    expect(call.connectorType).toBe('google_trends');
    expect(call.declaredPriceUsd).toBe(0.05);
    expect(call.req?.method).toBe('GET');
    expect(call.req?.url).toBe('https://google-trends.use.x402atlas.com/trend');
    expect(call.req?.query).toEqual({ keyword: 'bitcoin' });
  });

  it('refuses an unknown tool without touching the transport', async () => {
    const out = await googleTrendsExecutor(ctx('google_trends', 'nope', {}));
    expect(out.failure?.message).toContain('no tool named');
    expect(captured).toHaveLength(0);
  });

  it('surfaces a vendor error as a typed failure', async () => {
    vendorAnswer.status = 500;
    vendorAnswer.body = { error: 'upstream broke' };
    vendorAnswer.paidUsd = null;
    const out = await googleTrendsExecutor(ctx('google_trends', 'get_keyword_trend', { keyword: 'x' }));
    expect(out.failure?.message).toContain('HTTP 500');
  });
});

describe('browserbase_x402 executor', () => {
  it('POSTs only the allow-listed fields and books the receipt', async () => {
    vendorAnswer.paidUsd = 0.01;
    vendorAnswer.body = { results: [] };
    const out = await browserbaseX402Executor(ctx('browserbase_x402', 'search_the_web', {
      query: 'liftoff', numResults: 5, allowInsecureSsl: true, proxies: true,
    }));
    expect(out.failure).toBeUndefined();
    expect(out.costUsd).toBeCloseTo(0.01, 9);
    const call = captured[0];
    expect(call.declaredPriceUsd).toBe(0.01);
    expect(call.req?.method).toBe('POST');
    expect(call.req?.url).toBe('https://x402.browserbase.com/search');
    // The dangerous knobs never reach the vendor, whatever the input carried.
    expect(call.req?.body).toEqual({ query: 'liftoff', numResults: 5 });
  });
});

describe('kadec0 executor', () => {
  it('GETs the curated path with query params and books the receipt', async () => {
    vendorAnswer.paidUsd = 0.05;
    const out = await kadec0Executor(ctx('kadec0', 'search_web_serp', { q: 'x402', num_results: 3 }));
    expect(out.failure).toBeUndefined();
    expect(out.costUsd).toBeCloseTo(0.05, 9);
    const call = captured[0];
    expect(call.req?.url).toBe('https://api.kadec0.xyz/v1/serp');
    expect(call.req?.query).toEqual({ q: 'x402', num_results: '3' });
  });
});

describe('strale keyless x402 fallback lane', () => {
  afterEach(() => { delete process.env.STRALE_X402_ENABLED; });

  it('pays the capability endpoint when NO key exists, the lane is ENABLED, and x402 is configured', async () => {
    process.env.STRALE_X402_ENABLED = 'true';
    vendorAnswer.paidUsd = 0.0216;
    vendorAnswer.body = { lat: 1, lng: 2 };
    const out = await straleExecutor(ctx('strale', 'address_geocode', { address: '1 Main St' }));
    expect(out.failure).toBeUndefined();
    const call = captured[0];
    expect(call.connectorType).toBe('strale');
    expect(call.declaredPriceUsd).toBe(0.0216);
    expect(String(call.req?.url)).toContain('https://api.strale.io/x402/');
    expect(out.costUsd).toBeCloseTo(0.0216, 9);
    expect(out.fundingSource).toBe('x402_wallet');
    expect((out.result as { output: unknown }).output).toEqual({ lat: 1, lng: 2 });
  });

  it('refuses when the lane is NOT enabled, even with x402 configured — the interlock', async () => {
    // Losing the platform key must stay a clean failure, never a silent
    // switch onto wallet money the runtime would not attribute (INV-PB-013).
    const out = await straleExecutor(ctx('strale', 'address_geocode', { address: '1 Main St' }));
    expect(out.failure?.message).toContain('not provisioned');
    expect(captured).toHaveLength(0);
  });

  it('still refuses cleanly when x402 is not configured either', async () => {
    process.env.STRALE_X402_ENABLED = 'true';
    isX402ConfiguredMock.mockReturnValue(false);
    const out = await straleExecutor(ctx('strale', 'address_geocode', { address: '1 Main St' }));
    expect(out.failure?.message).toContain('not provisioned');
    expect(captured).toHaveLength(0);
  });
});

describe('strale: whose money pays', () => {
  afterEach(() => { delete process.env.STRALE_X402_ENABLED; });

  it('a workspace\'s own key runs the key lane on their account, never the wallet', async () => {
    process.env.STRALE_X402_ENABLED = 'true';
    platformKeyMock.mockReturnValue('platform-key');
    const own = { ...ctx('strale', 'address_geocode', { address: '1 Main St' }), connectorId: 'conn-42', credentials: { flowKind: 'api_key', apiKey: 'their-key' } };
    const out = await straleExecutor(own as ExecutorContext);
    expect(out.fundingSource).toBe('tenant_key');
    expect(keyLaneCalls).toEqual([{ accessToken: 'their-key', url: 'https://api.strale.io/v1/do' }]);
    expect(captured).toHaveLength(0);
  });

  it('a platform-funded call pays x402 even while the platform key is mounted', async () => {
    process.env.STRALE_X402_ENABLED = 'true';
    platformKeyMock.mockReturnValue('platform-key');
    vendorAnswer.paidUsd = 0.0216;
    vendorAnswer.body = { lat: 1 };
    const out = await straleExecutor(ctx('strale', 'address_geocode', { address: '1 Main St' }));
    expect(out.fundingSource).toBe('x402_wallet');
    expect(captured).toHaveLength(1);
    expect(keyLaneCalls).toHaveLength(0);
  });

  it('falls to the platform key only for a capability strale does not sell over x402', async () => {
    process.env.STRALE_X402_ENABLED = 'true';
    platformKeyMock.mockReturnValue('platform-key');
    vendorAnswer.status = 404;
    vendorAnswer.body = { error: 'Capability not found or not available via x402.', hint: 'https://api.strale.io/x402/catalog' };
    vendorAnswer.paidUsd = 0;
    const out = await straleExecutor(ctx('strale', 'invoice_verify_uk', { invoice: 'x' }));
    expect(out.failure).toBeUndefined();
    expect(out.fundingSource).toBe('platform_key');
    expect(captured).toHaveLength(1);
    expect(keyLaneCalls).toEqual([{ accessToken: 'platform-key', url: 'https://api.strale.io/v1/do' }]);
  });

  it('does not fall to the platform key on any other x402 failure, and not at all without a platform key', async () => {
    process.env.STRALE_X402_ENABLED = 'true';
    platformKeyMock.mockReturnValue('platform-key');
    vendorAnswer.status = 500;
    vendorAnswer.body = { error: 'upstream' };
    vendorAnswer.paidUsd = 0;
    const out = await straleExecutor(ctx('strale', 'address_geocode', { address: '1 Main St' }));
    expect(out.failure?.message).toContain('HTTP 500');
    expect(keyLaneCalls).toHaveLength(0);

    platformKeyMock.mockReturnValue(undefined);
    vendorAnswer.status = 404;
    vendorAnswer.body = { error: 'Capability not found or not available via x402.' };
    const none = await straleExecutor(ctx('strale', 'invoice_verify_uk', { invoice: 'x' }));
    expect(none.failure?.message).toContain('HTTP 404');
    expect(keyLaneCalls).toHaveLength(0);
  });

  it('with the lane off, the platform key is the platform lane as before', async () => {
    platformKeyMock.mockReturnValue('platform-key');
    const out = await straleExecutor(ctx('strale', 'address_geocode', { address: '1 Main St' }));
    expect(out.fundingSource).toBe('platform_key');
    expect(captured).toHaveLength(0);
    expect(keyLaneCalls).toEqual([{ accessToken: 'platform-key', url: 'https://api.strale.io/v1/do' }]);
  });
});
