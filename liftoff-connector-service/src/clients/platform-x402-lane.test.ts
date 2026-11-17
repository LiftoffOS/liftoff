// The platform funding order for a keyless x402 call: Vaaya's auto-reloading
// balance, then the platform's own wallet. The properties that matter are the
// two that decide money — the wallet is asked only when Vaaya charged nothing,
// and a model argument cannot point a pass-through somewhere else.

const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
let script: Array<{ status: number; body: unknown }> = [];
jest.mock('./connector-transport.js', () => ({
  DEFAULT_PUBLIC_WEB_HEADERS: { 'User-Agent': 'test' },
  makePublicWebTransport: (_type: string, headers: Record<string, string>) => async (req: { url: string; body?: unknown }) => {
    calls.push({ url: req.url, headers, body: req.body });
    const next = script.shift() ?? { status: 500, body: {} };
    return { ok: next.status < 400, status: next.status, json: async () => next.body } as unknown as Response;
  },
  makeX402Transport: jest.fn(),
  readX402Receipt: jest.fn(),
}));
jest.mock('../infra/logging.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { payViaVaaya, PLATFORM_X402_FUNDERS } from './platform-x402-lane.js';
import { VAAYA_PASSTHROUGH } from '../catalog/generated/vaaya-passthrough.js';

beforeEach(() => { calls.length = 0; script = []; process.env.VAAYA_API_KEY = 'vaaya_sk_test'; delete process.env.VAAYA_PASSTHROUGH; });
afterAll(() => { delete process.env.VAAYA_API_KEY; delete process.env.VAAYA_PASSTHROUGH; });

const trend = { connectorType: 'google_trends', functionName: 'get_keyword_trend', path: '/trend', declaredPriceUsd: 0.05 };

it('asks Vaaya first, on the resold action, and books the charge it reports', async () => {
  script = [{ status: 200, body: { ok: true, data: { keyword: 'ai agents', series: [] }, charged_cents: 5 } }];
  const out = await payViaVaaya({ ...trend, input: { keyword: 'ai agents' } as never });

  expect(out.funded).toBe(true);
  if (!out.funded) throw new Error('unreachable');
  expect(out.costUsd).toBeCloseTo(0.05, 9);
  expect(out.result).toEqual({ keyword: 'ai agents', series: [] });
  expect(calls[0].url).toBe('https://vaaya.ai/api/run/google-trends/fetch');
  expect(calls[0].headers.Authorization).toBe('Bearer vaaya_sk_test');
  // The ceiling is Vaaya's own listed price doubled, not ours.
  expect(calls[0].body).toEqual({ keyword: 'ai agents', endpoint: '/trend', max_cost_cents: 10 });
});

it('pins the upstream path: an input argument named endpoint cannot redirect the call', async () => {
  script = [{ status: 200, body: { ok: true, data: {}, charged_cents: 5 } }];
  await payViaVaaya({ ...trend, input: { keyword: 'x', endpoint: '/x402/v2/adverse-media-check' } as never });
  expect((calls[0].body as { endpoint: string }).endpoint).toBe('/trend');
});

it('leaves the call to the wallet when Vaaya refused and charged nothing', async () => {
  script = [{ status: 502, body: { ok: false, data: { error: 'upstream_error' }, charged_cents: 0 } }];
  const out = await payViaVaaya({ ...trend, input: { keyword: 'x' } as never });
  expect(out).toEqual({ funded: false, reason: 'unpaid' });
});

it('does NOT let the wallet pay again when Vaaya failed but still charged', async () => {
  script = [{ status: 500, body: { ok: false, error: 'provider timed out', charged_cents: 5 } }];
  const out = await payViaVaaya({ ...trend, input: { keyword: 'x' } as never });

  expect(out.funded).toBe(true);
  if (!out.funded) throw new Error('unreachable');
  expect(out.costUsd).toBeCloseTo(0.05, 9);
  expect(out.failure?.message).toContain('provider timed out');
});

it('leaves the call to the wallet when the lane cannot be reached at all', async () => {
  script = [];
  const boom = jest.requireMock('./connector-transport.js') as { makePublicWebTransport: unknown };
  const original = boom.makePublicWebTransport;
  boom.makePublicWebTransport = () => async () => { throw new Error('ECONNRESET'); };
  const out = await payViaVaaya({ ...trend, input: { keyword: 'x' } as never });
  boom.makePublicWebTransport = original;
  expect(out).toEqual({ funded: false, reason: 'unpaid' });
});

it('declines an endpoint Vaaya does not resell, and browserbase is all of them', async () => {
  const out = await payViaVaaya({ connectorType: 'browserbase_x402', functionName: 'search_the_web', path: '/search', input: {} as never });
  expect(out).toEqual({ funded: false, reason: 'not_mapped' });
  expect(VAAYA_PASSTHROUGH.browserbase_x402).toBeUndefined();
  expect(calls).toHaveLength(0);
});

it('declines with no key, and when an operator turns the rung off', async () => {
  delete process.env.VAAYA_API_KEY;
  expect(await payViaVaaya({ ...trend, input: {} as never })).toEqual({ funded: false, reason: 'not_configured' });

  process.env.VAAYA_API_KEY = 'vaaya_sk_test';
  process.env.VAAYA_PASSTHROUGH = 'off';
  expect(await payViaVaaya({ ...trend, input: {} as never })).toEqual({ funded: false, reason: 'disabled' });
  expect(calls).toHaveLength(0);
});

it('maps strale v2 slugs onto the v1 slugs Vaaya resells, and never invents one', () => {
  expect(PLATFORM_X402_FUNDERS).toEqual(['vaaya', 'x402_wallet']);
  expect(VAAYA_PASSTHROUGH.strale['/x402/v2/age-verify']).toEqual({ action: 'strale/check', endpoint: '/x402/age-verify', priceCents: 3 });
  // A capability Vaaya does not carry stays absent rather than being guessed at.
  expect(VAAYA_PASSTHROUGH.strale['/x402/v2/academic-paper-search']).toBeUndefined();
});
