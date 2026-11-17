// The x402 paying fetch, end to end against a FAKE payment library: a 402
// challenge → spend-guard consulted → signed retry → 200 with a settle header
// → receipt decoded, ledger recorded, paid amount re-exposed on the synthetic
// response headers the executor reads. No network, no chain, no real signing.

import { readX402Receipt } from '../../clients/connector-transport.js';

// ── Fakes ────────────────────────────────────────────────────────────────
// The library seam is @x402/fetch: wrapFetchWithPayment simulates the
// protocol (challenge → hook → payment header → retry), which is exactly the
// contract payment-client codes against.

const challenge = {
  current: {
    x402Version: 2,
    resource: { url: 'https://vendor.example/paid' },
    accepts: [
      { scheme: 'exact', network: 'eip155:8453', asset: '0xUSDC', amount: '11000', payTo: '0xseller', maxTimeoutSeconds: 60, extra: {} },
    ],
  },
};
// The settle receipt the fake vendor answers with. `amount` may be omitted to
// exercise the authorized-amount fallback. `null` = vendor never challenges.
const settle = {
  current: { success: true, transaction: '0xabc123', network: 'eip155:8453', amount: '11000' } as
    | { success: boolean; transaction: string; network: string; amount?: string }
    | null,
};

const setSpendControlsMock = jest.fn();

jest.mock('@x402/fetch', () => {
  class FakeX402Client {
    register() { return this; }
    registerV1() { return this; }
    setSpendControls(controls: unknown) { setSpendControlsMock(controls); return this; }
  }
  class FakeX402HTTPClient {
    private hooks: Array<(ctx: { paymentRequired: unknown; requestUrl: string }) => Promise<unknown>> = [];
    constructor(_client: unknown) {}
    onPaymentRequired(hook: (ctx: { paymentRequired: unknown; requestUrl: string }) => Promise<unknown>) {
      this.hooks.push(hook);
      return this;
    }
    async runHooks(requestUrl: string): Promise<void> {
      for (const hook of this.hooks) await hook({ paymentRequired: challenge.current, requestUrl });
    }
    getPaymentSettleResponse(getHeader: (name: string) => string | null | undefined) {
      const raw = getHeader('x-payment-response');
      if (!raw) throw new Error('no payment response header');
      return JSON.parse(raw);
    }
  }
  return {
    x402Client: FakeX402Client,
    x402HTTPClient: FakeX402HTTPClient,
    wrapFetchWithPayment: (_fetch: unknown, httpClient: FakeX402HTTPClient) =>
      async (url: string, _init?: RequestInit): Promise<Response> => {
        if (settle.current === null) {
          // Free endpoint: no challenge, no payment.
          return new Response('{"ok":true}', { status: 200 });
        }
        // 402 received → hooks run before any signing. A hook that throws
        // aborts the payment, exactly like the real wrapper.
        await httpClient.runHooks(url);
        return new Response('{"ok":true}', {
          status: 200,
          headers: { 'x-payment-response': JSON.stringify(settle.current) },
        });
      },
  };
});

jest.mock('@x402/evm', () => ({ ExactEvmScheme: class { constructor(_signer: unknown) {} } }));
jest.mock('@x402/evm/exact/v1/client', () => ({ ExactEvmSchemeV1: class { constructor(_signer: unknown) {} } }));

jest.mock('../wallet.js', () => ({
  getX402Signer: jest.fn(async () => ({ address: '0xwallet', signTypedData: jest.fn() })),
}));

const queryMock = jest.fn();
jest.mock('../../db/pool.js', () => ({
  getAdminPool: async () => ({ query: queryMock }),
}));

import { x402Fetch } from '../payment-client.js';
import { X402SpendRefusedError } from '../spend-guard.js';

function req(overrides: Record<string, unknown> = {}) {
  return { method: 'POST' as const, url: 'https://vendor.example/paid', body: { q: 1 }, ...overrides };
}

beforeEach(() => {
  queryMock.mockReset();
  setSpendControlsMock.mockClear();
  // Ledger read (ceiling check) answers empty; ledger write succeeds.
  queryMock.mockResolvedValue({ rows: [{ vendor_spent: null, total_spent: null }], rowCount: 1 });
  challenge.current.accepts[0].amount = '11000'; // $0.011
  settle.current = { success: true, transaction: '0xabc123', network: 'eip155:8453', amount: '11000' };
});

describe('x402Fetch', () => {
  it('pays a 402, records the spend, and exposes the receipt to the executor', async () => {
    const resp = await x402Fetch('gloria', undefined, req());
    expect(resp.status).toBe(200);

    const receipt = readX402Receipt(resp);
    expect(receipt?.amountUsd).toBeCloseTo(0.011, 9);
    expect(receipt?.transaction).toBe('0xabc123');

    const insert = queryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO x402_spend_ledger'));
    expect(insert).toBeDefined();
    expect((insert as unknown[])[1]).toEqual(expect.arrayContaining(['gloria']));
  });

  it('books the AUTHORIZED amount when the settle receipt omits amount', async () => {
    settle.current = { success: true, transaction: '0xdef', network: 'eip155:8453' };
    const resp = await x402Fetch('gloria', undefined, req());
    expect(readX402Receipt(resp)?.amountUsd).toBeCloseTo(0.011, 9);
  });

  it('refuses an over-cap challenge BEFORE paying', async () => {
    challenge.current.accepts[0].amount = '50000'; // $0.05 > floor cap $0.02
    await expect(x402Fetch('gloria', undefined, req())).rejects.toThrow(X402SpendRefusedError);
    const insert = queryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO x402_spend_ledger'));
    expect(insert).toBeUndefined();
  });

  it('honours the declared price ×2 cap over the floor', async () => {
    challenge.current.accepts[0].amount = '50000'; // $0.05 <= 0.04×2
    settle.current = { success: true, transaction: '0x50k', network: 'eip155:8453', amount: '50000' };
    const resp = await x402Fetch('gloria', { declaredPriceUsd: 0.04 }, req());
    expect(readX402Receipt(resp)?.amountUsd).toBeCloseTo(0.05, 9);
  });

  it('passes a free (never-challenged) response through untouched', async () => {
    settle.current = null;
    const resp = await x402Fetch('gloria', undefined, req());
    expect(resp.status).toBe(200);
    expect(readX402Receipt(resp)).toBeUndefined();
    const insert = queryMock.mock.calls.find(([sql]) => String(sql).includes('INSERT INTO x402_spend_ledger'));
    expect(insert).toBeUndefined();
  });

  it('hands the library a per-payment spend control as belt-and-braces', async () => {
    await x402Fetch('gloria', undefined, req());
    expect(setSpendControlsMock).toHaveBeenCalledWith(
      expect.objectContaining({ maxAmountPerPayment: '$0.020000' }),
    );
  });

  it('prices a v1 challenge (network name, maxAmountRequired) for the guard', async () => {
    // browserbase still speaks x402Version 1: the offer names the network
    // 'base' and carries maxAmountRequired instead of amount. The guard must
    // read it, or every v1 challenge would price as "unknown" and refuse at
    // the cap even for a 1-cent call.
    challenge.current.accepts[0] = {
      scheme: 'exact', network: 'base' as never, asset: '0xUSDC',
      maxAmountRequired: '10000', payTo: '0xseller', maxTimeoutSeconds: 30, extra: {},
    } as never;
    settle.current = { success: true, transaction: '0xv1', network: 'base', amount: '10000' };
    const resp = await x402Fetch('browserbase_x402', undefined, req());
    expect(readX402Receipt(resp)?.amountUsd).toBeCloseTo(0.01, 9);
  });
});
