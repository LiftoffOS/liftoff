// A prepaid token is an x402 payment whose answer is a credential. The
// purchase must ride the paying fetch with the cap pinned to the ordered
// amount (a vendor asking for more is refused by the guard, not paid), read
// the vendor's answer strictly (no token, no purchase), and hand the token
// back with the settle receipt rather than a figure of its own.

const recordSpendMock = jest.fn(async (_vendor: string, _usd: number) => undefined);
jest.mock('../spend-guard.js', () => {
  const actual = jest.requireActual('../spend-guard.js');
  return { ...actual, recordX402Spend: (vendor: string, usd: number) => recordSpendMock(vendor, usd) };
});

jest.mock('../../infra/logging.js', () => ({ logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } }));

import { X402_PAID_USD_HEADER, X402_TRANSACTION_HEADER } from '../../clients/connector-transport.js';
import { PREPAID_TOKEN_MAX_USD, PrepaidTokenError, purchasePrepaidToken, purchasePrepaidTokenViaLocus } from '../prepaid-tokens.js';

beforeEach(() => recordSpendMock.mockClear());

function paidResponse(body: unknown, paidUsd: number, status = 201): Response {
  const headers = new Headers({ 'content-type': 'application/json' });
  headers.set(X402_PAID_USD_HEADER, paidUsd.toFixed(6));
  headers.set(X402_TRANSACTION_HEADER, '0xsettled');
  return new Response(JSON.stringify(body), { status, headers });
}

const ANSWER = { token: 'apify_api_prepaid_abc', remainingBalanceUsd: 10, expiresAt: '2026-10-03T00:00:00.000Z' };

describe('purchasePrepaidToken', () => {
  it('pays Apify with the cap pinned to the ordered amount and returns the token with the receipt', async () => {
    const fetchImpl = jest.fn(async () => paidResponse(ANSWER, 10));
    const bought = await purchasePrepaidToken('apify', 10, fetchImpl);
    expect(bought).toEqual({
      vendor: 'apify',
      token: 'apify_api_prepaid_abc',
      balanceUsd: 10,
      expiresAt: ANSWER.expiresAt,
      paidUsd: 10,
      transaction: '0xsettled',
      fundedBy: 'x402_wallet',
    });
    const [vendor, opts, req] = fetchImpl.mock.calls[0] as unknown as [string, Record<string, unknown>, Record<string, unknown>];
    expect(vendor).toBe('apify');
    expect(opts).toEqual({ maxPaymentAmountUsd: 10, declaredPriceUsd: 10 });
    expect(req).toMatchObject({
      method: 'GET',
      url: 'https://agi.apify.com/protocols/x402/prepaid-tokens',
      query: { amount: '10', currency: 'usd' },
    });
  });

  it('books the ordered amount itself when the vendor answers with a token but no settle receipt', async () => {
    const fetchImpl = jest.fn(async () => new Response(JSON.stringify(ANSWER), { status: 201, headers: { 'content-type': 'application/json' } }));
    const bought = await purchasePrepaidToken('apify', 1, fetchImpl);
    expect(bought).toMatchObject({ token: ANSWER.token, paidUsd: 1 });
    expect(bought.transaction).toBeUndefined();
    expect(recordSpendMock).toHaveBeenCalledWith('apify', 1);
  });

  it('does not book twice when the receipt is present', async () => {
    const fetchImpl = jest.fn(async () => paidResponse(ANSWER, 10));
    await purchasePrepaidToken('apify', 10, fetchImpl);
    expect(recordSpendMock).not.toHaveBeenCalled();
  });

  it('reads the answer under `data` as well', async () => {
    const fetchImpl = jest.fn(async () => paidResponse({ data: ANSWER }, 10));
    expect((await purchasePrepaidToken('apify', 10, fetchImpl)).token).toBe(ANSWER.token);
  });

  it('refuses a vendor that sells no token and an amount outside the float', async () => {
    const fetchImpl = jest.fn();
    await expect(purchasePrepaidToken('strale', 10, fetchImpl)).rejects.toMatchObject({ reason: 'bad_request' });
    await expect(purchasePrepaidToken('apify', 0.5, fetchImpl)).rejects.toMatchObject({ reason: 'bad_request' });
    await expect(purchasePrepaidToken('apify', PREPAID_TOKEN_MAX_USD + 1, fetchImpl)).rejects.toMatchObject({ reason: 'bad_request' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('does not invent a token from an answer without one, and reports a vendor refusal as such', async () => {
    const noToken = jest.fn(async () => paidResponse({ ok: true }, 10));
    await expect(purchasePrepaidToken('apify', 10, noToken)).rejects.toMatchObject({ reason: 'vendor_answer_unrecognised' });

    const refused = jest.fn(async () => new Response(JSON.stringify({ error: 'insufficient funds' }), { status: 402 }));
    await expect(purchasePrepaidToken('apify', 10, refused)).rejects.toMatchObject({ reason: 'vendor_refused' });
    const err = await purchasePrepaidToken('apify', 10, refused).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(PrepaidTokenError);
    expect((err as Error).message).toMatch(/402/);
  });

  it('lets the guard\'s refusal through untouched', async () => {
    const { X402SpendRefusedError } = await import('../spend-guard.js');
    const guarded = jest.fn(async () => { throw new X402SpendRefusedError('daily_ceiling', 'over the ceiling'); });
    await expect(purchasePrepaidToken('apify', 10, guarded)).rejects.toMatchObject({ name: 'X402SpendRefusedError', reason: 'daily_ceiling' });
  });
});

// The fallback funder: Locus pays Apify's challenge from its own wallet and
// charges the platform's card-funded credits. Same token, same answer shape,
// a different funder on the receipt, and nothing in the wallet's ledger.
describe('purchasePrepaidTokenViaLocus', () => {
  const SLUG = 'x402-agi-apify-com-protocols-x402-prepaid-tokens/call';
  type Call = { slug: string; body: Record<string, unknown>; key: string };
  function scripted(answer: { body: unknown; costUsd?: number } | Error) {
    const calls: Call[] = [];
    const impl = jest.fn(async (slug: string, body: Record<string, unknown>, key: string) => {
      calls.push({ slug, body, key });
      if (answer instanceof Error) throw answer;
      return { status: 200, body: answer.body, costUsd: answer.costUsd };
    });
    return { calls, impl };
  }

  it('posts the amount to the token slug on the platform key and returns the token funded by locus, at the charge Locus reported', async () => {
    const { calls, impl } = scripted({ body: { token: 'apify_api_prepaid_locus', remainingBalanceUsd: 1, expiresAt: '2026-10-04T00:00:00.000Z' }, costUsd: 1 });
    const bought = await purchasePrepaidTokenViaLocus('apify', 1, impl);
    expect(bought).toEqual({ vendor: 'apify', token: 'apify_api_prepaid_locus', balanceUsd: 1, expiresAt: '2026-10-04T00:00:00.000Z', paidUsd: 1, fundedBy: 'locus' });
    expect(calls[0]).toMatchObject({ slug: SLUG, body: { amount: '1', currency: 'usd' } });
    expect(calls[0].key).toMatch(/^prepaid-apify-1-/);
    expect(recordSpendMock).not.toHaveBeenCalled();
  });

  it('books the ordered amount when Locus reports no charge, and reads an answer under data', async () => {
    const { impl } = scripted({ body: { data: { token: 'apify_api_x', remainingBalanceUsd: 2, expiresAt: '2026-10-04T00:00:00.000Z' } } });
    expect(await purchasePrepaidTokenViaLocus('apify', 2, impl)).toMatchObject({ paidUsd: 2, balanceUsd: 2, fundedBy: 'locus' });
  });

  it("reports an empty Locus balance as the funder being unavailable, a provider refusal as the vendor's, and an answer without a token as unrecognised", async () => {
    const { LocusRefusal } = await import('../../clients/locus.js');
    const empty = scripted(new LocusRefusal('HTTP 402 payment required: insufficient credits', 402));
    await expect(purchasePrepaidTokenViaLocus('apify', 1, empty.impl)).rejects.toMatchObject({ reason: 'funder_unavailable' });
    const refused = scripted(new LocusRefusal('HTTP 400 amount must be at least 1', 400));
    await expect(purchasePrepaidTokenViaLocus('apify', 1, refused.impl)).rejects.toMatchObject({ reason: 'vendor_refused' });
    const noToken = scripted({ body: { ok: true }, costUsd: 0 });
    await expect(purchasePrepaidTokenViaLocus('apify', 1, noToken.impl)).rejects.toMatchObject({ reason: 'vendor_answer_unrecognised' });
  });

  it('refuses without a Locus key, and outside the float, before calling anyone', async () => {
    delete process.env.LOCUS_API_KEY;
    await expect(purchasePrepaidTokenViaLocus('apify', 1)).rejects.toMatchObject({ reason: 'funder_unavailable' });
    const { calls, impl } = scripted({ body: {} });
    await expect(purchasePrepaidTokenViaLocus('strale', 1, impl)).rejects.toMatchObject({ reason: 'bad_request' });
    await expect(purchasePrepaidTokenViaLocus('apify', 0.5, impl)).rejects.toMatchObject({ reason: 'bad_request' });
    expect(calls).toHaveLength(0);
  });
});
