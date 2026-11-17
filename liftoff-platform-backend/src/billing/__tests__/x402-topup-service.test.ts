// The Coinbase → treasury top-up: env gates, trigger conditions, the
// deterministic per-day idempotency token, and the coinbase-short verdict.
// Coinbase's API and the chain are both scripted fakes — no network.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const TREASURY = '0x2222222222222222222222222222222222222222';
jest.mock('@coinbase/cdp-sdk', () => ({
  CdpClient: class {
    evm = { getOrCreateAccount: async () => ({ address: TREASURY, transfer: jest.fn() }) };
  },
}));
const generateJwtMock = jest.fn(async () => 'jwt-token');
jest.mock('@coinbase/cdp-sdk/auth', () => ({
  generateJwt: (...a: unknown[]) => generateJwtMock(...a),
}));

import { runX402Topup, topupConfigured } from '../x402-topup-service';

const WALLET = '0x1111111111111111111111111111111111111111';

const chain = {
  treasuryAtomic: 50_000_000n, // $50
  ethWei: 10n ** 15n,          // 0.001 ETH
};
const coinbase = {
  usdcBalance: '100.00',
  ethBalance: '0.05',
  sends: [] as Array<{ path: string; body: Record<string, unknown> }>,
  failSend: false,
};

function coinbaseAnswer(method: string, path: string, body?: Record<string, unknown>): unknown {
  if (method === 'GET' && path === '/v2/accounts/USDC') {
    return { id: 'acct-usdc', balance: { amount: coinbase.usdcBalance, currency: 'USDC' } };
  }
  if (method === 'GET' && path === '/v2/accounts/ETH') {
    return { id: 'acct-eth', balance: { amount: coinbase.ethBalance, currency: 'ETH' } };
  }
  if (method === 'POST' && path.includes('/transactions')) {
    if (coinbase.failSend) throw new Error('send refused');
    coinbase.sends.push({ path, body: body! });
    return { id: `tx-${coinbase.sends.length}`, status: 'pending' };
  }
  throw new Error(`unscripted coinbase call ${method} ${path}`);
}

beforeEach(() => {
  jest.clearAllMocks();
  chain.treasuryAtomic = 50_000_000n;
  chain.ethWei = 10n ** 15n;
  coinbase.usdcBalance = '100.00';
  coinbase.ethBalance = '0.05';
  coinbase.sends = [];
  coinbase.failSend = false;
  process.env.X402_WALLET_ADDRESS = WALLET;
  process.env.CDP_API_KEY_ID = 'k';
  process.env.CDP_API_KEY_SECRET = 's';
  process.env.CDP_WALLET_SECRET = 'w';
  process.env.COINBASE_TOPUP_KEY_ID = 'topup-key';
  process.env.COINBASE_TOPUP_KEY_SECRET = 'topup-secret';

  global.fetch = jest.fn(async (url, init) => {
    const u = String(url);
    const opts = init as RequestInit;
    if (u.includes('api.coinbase.com')) {
      const path = u.replace('https://api.coinbase.com', '');
      const method = String(opts.method);
      try {
        const data = coinbaseAnswer(method, path, opts.body ? JSON.parse(String(opts.body)) : undefined);
        return { ok: true, status: 200, json: async () => ({ data }) } as unknown as Response;
      } catch (e) {
        return {
          ok: false, status: 400,
          json: async () => ({ errors: [{ message: (e as Error).message }] }),
        } as unknown as Response;
      }
    }
    // Base RPC: balances only in this suite.
    const body = JSON.parse(String(opts.body));
    const result = body.method === 'eth_call'
      ? '0x' + chain.treasuryAtomic.toString(16)
      : body.method === 'eth_getBalance'
        ? '0x' + chain.ethWei.toString(16)
        : (() => { throw new Error(`unscripted rpc ${body.method}`); })();
    return { ok: true, json: async () => ({ jsonrpc: '2.0', id: 1, result }) } as unknown as Response;
  }) as unknown as typeof fetch;
});

afterEach(() => {
  delete process.env.X402_WALLET_ADDRESS;
  delete process.env.CDP_API_KEY_ID;
  delete process.env.CDP_API_KEY_SECRET;
  delete process.env.CDP_WALLET_SECRET;
  delete process.env.COINBASE_TOPUP_KEY_ID;
  delete process.env.COINBASE_TOPUP_KEY_SECRET;
});

describe('gates', () => {
  it('reports each missing configuration in order', async () => {
    delete process.env.X402_WALLET_ADDRESS;
    await expect(runX402Topup()).resolves.toEqual({ skipped: 'wallet_not_configured' });
    process.env.X402_WALLET_ADDRESS = WALLET;
    delete process.env.CDP_API_KEY_ID;
    await expect(runX402Topup()).resolves.toEqual({ skipped: 'cdp_not_configured' });
    process.env.CDP_API_KEY_ID = 'k';
    delete process.env.COINBASE_TOPUP_KEY_ID;
    expect(topupConfigured()).toBe(false);
    await expect(runX402Topup()).resolves.toEqual({ skipped: 'topup_not_configured' });
  });
});

describe('topping up', () => {
  it('does nothing while the treasury is healthy', async () => {
    const result = await runX402Topup();
    expect(result.topped).toBe(false);
    expect(coinbase.sends).toHaveLength(0);
  });

  it('sends $20 USDC on Base when the treasury dips under the floor, with a deterministic per-day idem', async () => {
    chain.treasuryAtomic = 4_000_000n; // $4 < $10 floor
    const now = new Date('2026-09-11T10:00:00Z');
    const result = await runX402Topup(now);
    expect(result.topped).toBe(true);
    expect(result.coinbaseShort).toBe(false);
    expect(coinbase.sends).toHaveLength(1);
    const body = coinbase.sends[0].body;
    expect(body).toMatchObject({ type: 'send', to: TREASURY, amount: '20', currency: 'USDC', network: 'base' });

    // Same day → same idem, so Coinbase dedupes a replay; new day → new idem.
    coinbase.sends = [];
    await runX402Topup(now);
    const again = coinbase.sends[0].body;
    expect(again.idem).toBe(body.idem);
    coinbase.sends = [];
    await runX402Topup(new Date('2026-09-12T10:00:00Z'));
    expect(coinbase.sends[0].body.idem).not.toBe(body.idem);
  });

  it('tops the ETH gas tank when it runs low', async () => {
    chain.ethWei = 10n ** 13n; // 0.00001 < 0.0001
    const result = await runX402Topup();
    expect(result.eth?.sent).toBe(true);
    expect(coinbase.sends[0].body).toMatchObject({ currency: 'ETH', network: 'base', to: TREASURY });
    expect(result.usdc).toBeUndefined();
  });

  it('answers coinbaseShort — the raise-the-recurring-buy signal — without sending', async () => {
    chain.treasuryAtomic = 4_000_000n;
    coinbase.usdcBalance = '5.00'; // < $20 top-up
    const result = await runX402Topup();
    expect(result.coinbaseShort).toBe(true);
    expect(result.topped).toBe(false);
    expect(coinbase.sends).toHaveLength(0);
  });

  it('propagates a Coinbase refusal as a thrown error (the job answers 500)', async () => {
    chain.treasuryAtomic = 4_000_000n;
    coinbase.failSend = true;
    await expect(runX402Topup()).rejects.toThrow('send refused');
  });
});
