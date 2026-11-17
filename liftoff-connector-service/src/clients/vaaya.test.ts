// The Vaaya rung: one platform bearer, every call carries a whole-cent
// ceiling of double the listed price, the charge Vaaya reports is the cost
// the customer is billed from, and a refusal or an empty balance is a typed
// failure with nothing booked.

import type { ExecutorContext } from '../rpc/execute-dispatcher.js';

const calls: Array<{ url: string; headers: Record<string, string>; body: unknown }> = [];
let script: Array<{ status: number; body: unknown }> = [];
jest.mock('./connector-transport.js', () => ({
  DEFAULT_PUBLIC_WEB_HEADERS: { 'User-Agent': 'test' },
  makePublicWebTransport: (_type: string, headers: Record<string, string>) => async (req: { method: string; url: string; body?: unknown }) => {
    calls.push({ url: req.url, headers, body: req.body });
    const next = script.shift() ?? { status: 500, body: { error: 'unscripted' } };
    return { ok: next.status < 400, status: next.status, json: async () => next.body } as unknown as Response;
  },
}));
jest.mock('../infra/logging.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { vaayaExecutor, vaayaBalanceUsd, maxCostCents } from './vaaya.js';

function ctx(functionName: string, input: Record<string, unknown>): ExecutorContext {
  return {
    tenantId: 't-1', connectorId: 'internal:vaaya', connectorType: 'vaaya', connectorConfig: {},
    functionName, input: input as ExecutorContext['input'], idempotencyKey: 'idem-1', traceId: 'tr',
    credentials: { flowKind: 'api_key' },
  } as ExecutorContext;
}

beforeEach(() => { calls.length = 0; script = []; process.env.VAAYA_API_KEY = 'vaaya_sk_test'; });
afterAll(() => { delete process.env.VAAYA_API_KEY; });

it('caps at double the listed price in whole cents, never below one cent', () => {
  expect(maxCostCents(0.01)).toBe(2);
  expect(maxCostCents(0.04)).toBe(8);
  expect(maxCostCents(0.25)).toBe(50);
  expect(maxCostCents(0.001)).toBe(1);
});

it('posts the action with the bearer and the ceiling, and books the charge Vaaya reports as platform-funded cost', async () => {
  script = [{ status: 200, body: { ok: true, data: { email: 'a@b.co', score: 91 }, charged_cents: 5, balance_remaining_cents: 995, transaction_id: 'tx-1' } }];
  const out = await vaayaExecutor(ctx('linkedin_email', { url: 'https://linkedin.com/in/ada' }));
  expect(out.failure).toBeUndefined();
  expect(out.result).toEqual({ email: 'a@b.co', score: 91 });
  expect(out.costUsd).toBeCloseTo(0.05, 9);
  expect(out.fundingSource).toBe('platform_key');
  expect(calls[0].url).toBe('https://vaaya.ai/api/run/tomba/linkedin-finder');
  expect(calls[0].headers.Authorization).toBe('Bearer vaaya_sk_test');
  expect(calls[0].body).toEqual({ url: 'https://linkedin.com/in/ada', max_cost_cents: 10 });
});

it('the email find, verify and domain listing the locus card serves at a third of the price are no longer here', async () => {
  for (const fn of ['email_find', 'email_verify', 'domain_emails']) {
    expect((await vaayaExecutor(ctx(fn, {}))).failure?.message).toContain('no tool named');
  }
  expect(calls).toHaveLength(0);
});

it('wraps a list answer so the wire stays an object', async () => {
  script = [{ status: 200, body: { ok: true, data: [{ id: 1 }, { id: 2 }], charged_cents: 1 } }];
  const out = await vaayaExecutor(ctx('patent_search', { q: 'battery' }));
  expect(out.result).toEqual({ items: [{ id: 1 }, { id: 2 }] });
  expect(out.costUsd).toBeCloseTo(0.01, 9);
});

it('reports an empty platform balance as a failure with nothing booked', async () => {
  script = [{ status: 402, body: { error: 'insufficient balance' } }];
  const out = await vaayaExecutor(ctx('person_from_email', { email: 'x@y.z' }));
  expect(out.failure?.message).toContain('HTTP 402 payment required');
  expect(out.failure?.message).toContain('platform balance exhausted');
  expect(out.costUsd).toBeUndefined();
});

it('reports a provider error as the vendor described it, uncharged', async () => {
  script = [{ status: 500, body: { ok: false, error: { message: 'upstream timeout', code: 'UPSTREAM' } } }];
  const out = await vaayaExecutor(ctx('funding_rounds', { limit: 5 }));
  expect(out.failure?.message).toBe('vaaya funding_rounds failed: HTTP 500 upstream timeout');
  expect(out.costUsd).toBeUndefined();
});

it('refuses without a platform key and names an unknown tool', async () => {
  delete process.env.VAAYA_API_KEY;
  expect((await vaayaExecutor(ctx('person_from_email', { email: 'x@y.z' }))).failure?.message).toContain('not provisioned');
  process.env.VAAYA_API_KEY = 'vaaya_sk_test';
  expect((await vaayaExecutor(ctx('delete_everything', {}))).failure?.message).toContain('no tool named');
  expect(calls).toHaveLength(0);
});

it('reads the prepaid wallet in USD from cents, and refuses an answer without one', async () => {
  script = [{ status: 200, body: { wallet: { prepaid_cents: 987 } } }];
  expect(await vaayaBalanceUsd()).toBeCloseTo(9.87, 9);
  expect(calls[calls.length - 1].url).toBe('https://vaaya.ai/api/v1/wallet');
  script = [{ status: 200, body: { wallet: {} } }];
  await expect(vaayaBalanceUsd()).rejects.toThrow('no prepaid_cents');
});
