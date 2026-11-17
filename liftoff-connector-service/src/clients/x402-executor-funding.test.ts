// The three keyless x402 executors, where the funding order actually lands:
// a resold endpoint is paid from the Vaaya balance and books platform_key, an
// endpoint Vaaya does not resell still goes to the wallet and books
// x402_wallet, and strale's two lanes stay indistinguishable to a caller.

import type { ExecutorContext } from '../rpc/execute-dispatcher.js';

let vaayaScript: Array<{ status: number; body: unknown }> = [];
let x402Script: Array<{ status: number; body: unknown }> = [];
const vaayaCalls: Array<{ url: string; body: unknown }> = [];
const x402Calls: Array<{ url: string; method: string }> = [];

jest.mock('./connector-transport.js', () => ({
  DEFAULT_PUBLIC_WEB_HEADERS: { 'User-Agent': 'test' },
  makePublicWebTransport: () => async (req: { url: string; body?: unknown }) => {
    vaayaCalls.push({ url: req.url, body: req.body });
    const next = vaayaScript.shift() ?? { status: 500, body: {} };
    return { ok: next.status < 400, status: next.status, json: async () => next.body } as unknown as Response;
  },
  makeX402Transport: () => async (req: { url: string; method: string }) => {
    x402Calls.push({ url: req.url, method: req.method });
    const next = x402Script.shift() ?? { status: 500, body: {} };
    return { ok: next.status < 400, status: next.status, json: async () => next.body } as unknown as Response;
  },
  makeConnectorTransport: () => async () => ({ ok: true, status: 200, json: async () => ({}) } as unknown as Response),
  readX402Receipt: () => ({ amountUsd: 0.02 }),
}));
jest.mock('../infra/logging.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));
jest.mock('../rpc/execute-dispatcher.js', () => ({ registerConnectorExecutor: jest.fn() }));
jest.mock('../x402/wallet.js', () => ({ isX402Configured: () => true }));
jest.mock('./platform-vendor-keys.js', () => ({ resolvePlatformVendorKey: () => '', tenantOwnApiKey: () => '' }));

import { kadec0Executor } from './kadec0.js';
import { straleExecutor } from './strale.js';

function ctx(connectorType: string, functionName: string, input: Record<string, unknown>): ExecutorContext {
  return {
    tenantId: 't-1', connectorId: `internal:${connectorType}`, connectorType, connectorConfig: {},
    functionName, input: input as ExecutorContext['input'], idempotencyKey: 'idem-1', traceId: 'tr',
    credentials: { flowKind: 'api_key' },
  } as ExecutorContext;
}

beforeEach(() => {
  vaayaScript = []; x402Script = []; vaayaCalls.length = 0; x402Calls.length = 0;
  process.env.VAAYA_API_KEY = 'vaaya_sk_test';
  process.env.STRALE_X402_ENABLED = 'true';
  delete process.env.VAAYA_PASSTHROUGH;
});
afterAll(() => { delete process.env.VAAYA_API_KEY; delete process.env.STRALE_X402_ENABLED; });

it('kadec0: a resold endpoint is paid from the Vaaya balance, and the wallet is never asked', async () => {
  vaayaScript = [{ status: 200, body: { ok: true, data: { count: 1, items: [{ name: 'a' }] }, charged_cents: 7 } }];
  const out = await kadec0Executor(ctx('kadec0', 'get_congress_trades', {}));

  expect(out.failure).toBeUndefined();
  expect(out.fundingSource).toBe('platform_key');
  expect(out.costUsd).toBeCloseTo(0.07, 9);
  expect(vaayaCalls[0].url).toBe('https://vaaya.ai/api/run/kadec0/fetch');
  expect(x402Calls).toHaveLength(0);
});

it('kadec0: an endpoint Vaaya does not resell goes straight to the wallet', async () => {
  x402Script = [{ status: 200, body: { results: [] } }];
  const out = await kadec0Executor(ctx('kadec0', 'search_web_serp', { q: 'x' }));

  expect(out.fundingSource).toBe('x402_wallet');
  expect(vaayaCalls).toHaveLength(0);
  expect(x402Calls[0].url).toBe('https://api.kadec0.xyz/v1/serp');
});

it('kadec0: a Vaaya refusal that charged nothing falls through to the wallet', async () => {
  vaayaScript = [{ status: 502, body: { ok: false, charged_cents: 0 } }];
  x402Script = [{ status: 200, body: { ok: true } }];
  const out = await kadec0Executor(ctx('kadec0', 'get_congress_trades', {}));

  expect(out.fundingSource).toBe('x402_wallet');
  expect(vaayaCalls).toHaveLength(1);
  expect(x402Calls).toHaveLength(1);
});

it('strale: the Vaaya lane returns the key lane\'s shape, so no caller can tell which paid', async () => {
  vaayaScript = [{ status: 200, body: { ok: true, data: { age_years: 36, meets_minimum: true }, charged_cents: 3 } }];
  const out = await straleExecutor(ctx('strale', 'age_verify', { date_of_birth: '1990-01-01' }));

  expect(out.result).toEqual({ output: { age_years: 36, meets_minimum: true }, provenance: null });
  expect(out.fundingSource).toBe('platform_key');
  expect(out.costUsd).toBeCloseTo(0.03, 9);
  expect(vaayaCalls[0].url).toBe('https://vaaya.ai/api/run/strale/check');
  expect(x402Calls).toHaveLength(0);
});

it('strale: a capability Vaaya does not resell still rides the wallet', async () => {
  x402Script = [{ status: 200, body: { verdict: 'ok' } }];
  const out = await straleExecutor(ctx('strale', 'academic_paper_search', { q: 'x' }));

  expect(out.fundingSource).toBe('x402_wallet');
  expect(vaayaCalls).toHaveLength(0);
  expect(x402Calls[0].url).toBe('https://api.strale.io/x402/v2/academic-paper-search');
});

it('with the rung turned off, every one of these calls is back on the wallet', async () => {
  process.env.VAAYA_PASSTHROUGH = 'off';
  x402Script = [{ status: 200, body: { ok: true } }];
  const out = await kadec0Executor(ctx('kadec0', 'get_congress_trades', {}));

  expect(out.fundingSource).toBe('x402_wallet');
  expect(vaayaCalls).toHaveLength(0);
});
