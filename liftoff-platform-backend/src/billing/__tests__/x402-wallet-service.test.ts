// x402 wallet treasury checks: balance read, on-chain outbound sum, and the
// reconciliation verdict. The chain is a scripted JSON-RPC fake (a monotone
// 2s-per-block Base), the ledger a mocked admin-scope query — no network.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
}));

const mockLedgerQuery = jest.fn();
// The platform_prepaid_tokens reads (no RLS, plain pool): purchases on the
// day, and the live tokens' draw-down. Scripted per test; default: none.
const mockPoolQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  withAdminScope: jest.fn(async (_opts: unknown, fn: (c: unknown) => Promise<unknown>) =>
    fn({ query: mockLedgerQuery })),
  withTenantScope: jest.fn(),
  getPool: () => ({ query: mockPoolQuery }),
}));

const signerWalletMock = jest.fn();
jest.mock('../../connectors/connector-service-client', () => ({
  fetchX402SignerWallet: () => signerWalletMock(),
}));

const TREASURY = '0x2222222222222222222222222222222222222222';
const transferMock = jest.fn(async () => ({ transactionHash: '0xreload' }));
jest.mock('@coinbase/cdp-sdk', () => ({
  CdpClient: class {
    evm = {
      getOrCreateAccount: async () => ({ address: TREASURY, transfer: transferMock }),
    };
  },
}));

import {
  getX402WalletBalanceUsd,
  lowBalanceThresholdUsd,
  runX402LowBalanceCheck,
  runX402Reconciliation,
  runX402Reload,
  sumOutboundUsdcUsd,
  x402WalletAddress,
} from '../x402-wallet-service';

const WALLET = '0x1111111111111111111111111111111111111111';
const GENESIS_TS = 1_700_000_000;
const LATEST_BLOCK = 200_000;

// Per-address USDC balances (atomic), a shared ETH balance, and Transfer
// logs served per eth_getLogs chunk.
const chain = {
  balanceAtomic: 50_000_000n,           // $50 — the spending wallet
  treasuryAtomic: 50_000_000n,          // $50 — the treasury
  ethWei: 10n ** 15n,                   // 0.001 ETH gas tank
  logsPerChunk: [] as Array<{ data: string }>,
};

function scriptedRpc(method: string, params: unknown[]): unknown {
  switch (method) {
    case 'eth_call': {
      const call = params[0] as { data: string };
      const target = ('0x' + call.data.slice(-40)).toLowerCase();
      const atomic = target === TREASURY.toLowerCase() ? chain.treasuryAtomic : chain.balanceAtomic;
      return '0x' + atomic.toString(16);
    }
    case 'eth_getBalance':
      return '0x' + chain.ethWei.toString(16);
    case 'eth_blockNumber':
      return '0x' + LATEST_BLOCK.toString(16);
    case 'eth_getBlockByNumber': {
      const num = Number.parseInt((params[0] as string), 16);
      // A monotone 2s chain: timestamp derives from the block number, which
      // is what makes the binary search land deterministically.
      return { timestamp: '0x' + (GENESIS_TS + num * 2).toString(16) };
    }
    case 'eth_getLogs':
      return chain.logsPerChunk;
    default:
      throw new Error(`unscripted rpc method ${method}`);
  }
}

function configureCdpEnv(): void {
  process.env.CDP_API_KEY_ID = 'test-key-id';
  process.env.CDP_API_KEY_SECRET = 'test-key-secret';
  process.env.CDP_WALLET_SECRET = 'test-wallet-secret';
}

beforeEach(() => {
  jest.clearAllMocks();
  chain.balanceAtomic = 50_000_000n;
  chain.treasuryAtomic = 50_000_000n;
  chain.ethWei = 10n ** 15n;
  chain.logsPerChunk = [];
  delete process.env.X402_WALLET_ADDRESS;
  delete process.env.X402_LOW_BALANCE_THRESHOLD_USD;
  delete process.env.CDP_API_KEY_ID;
  delete process.env.CDP_API_KEY_SECRET;
  delete process.env.CDP_WALLET_SECRET;
  delete process.env.X402_RELOAD_MAX_PER_DAY;
  signerWalletMock.mockReset();
  signerWalletMock.mockResolvedValue({ provider: 'cdp', configured: true, address: WALLET });
  mockPoolQuery.mockReset();
  mockPoolQuery.mockImplementation(async (sql: string) =>
    String(sql).includes('SUM(purchased_usd - balance_usd)')
      ? { rows: [] }
      : { rows: [{ total: null, n: '0' }] });
  global.fetch = jest.fn(async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body));
    return {
      ok: true,
      json: async () => ({ jsonrpc: '2.0', id: 1, result: scriptedRpc(body.method, body.params) }),
    } as unknown as Response;
  }) as unknown as typeof fetch;
});

describe('x402WalletAddress', () => {
  it('accepts a checksummed address and lowercases it', () => {
    process.env.X402_WALLET_ADDRESS = '0xAbCd111111111111111111111111111111111111';
    expect(x402WalletAddress()).toBe('0xabcd111111111111111111111111111111111111');
  });

  it('refuses garbage and absence', () => {
    expect(x402WalletAddress()).toBeUndefined();
    process.env.X402_WALLET_ADDRESS = 'not-an-address';
    expect(x402WalletAddress()).toBeUndefined();
  });
});

describe('balance check', () => {
  it('reads balanceOf and converts 6-decimal atomic USDC to USD', async () => {
    chain.balanceAtomic = 123_456_789n;
    await expect(getX402WalletBalanceUsd(WALLET)).resolves.toBeCloseTo(123.456789, 6);
  });

  it('reports skipped before the wallet is configured', async () => {
    await expect(runX402LowBalanceCheck()).resolves.toEqual({ skipped: 'wallet_not_configured' });
  });

  it('flags a balance under the threshold', async () => {
    process.env.X402_WALLET_ADDRESS = WALLET;
    process.env.X402_LOW_BALANCE_THRESHOLD_USD = '60';
    const result = await runX402LowBalanceCheck();
    expect(result.low).toBe(true);
    expect(result.spendingBalanceUsd).toBeCloseTo(50, 6);
    expect(result.thresholdUsd).toBe(60);
  });

  it('passes a healthy balance and defaults the threshold', async () => {
    process.env.X402_WALLET_ADDRESS = WALLET;
    const result = await runX402LowBalanceCheck();
    expect(result.low).toBe(false);
    expect(lowBalanceThresholdUsd()).toBe(10);
  });

  it('with CDP configured, the threshold moves to the TREASURY — spending low is not a page', async () => {
    process.env.X402_WALLET_ADDRESS = WALLET;
    configureCdpEnv();
    chain.balanceAtomic = 500_000n;      // spending at $0.50 — self-healing, fine
    chain.treasuryAtomic = 40_000_000n;  // treasury at $40 — healthy
    const result = await runX402LowBalanceCheck();
    expect(result.low).toBe(false);
    expect(result.treasuryBalanceUsd).toBeCloseTo(40, 6);
  });

  it('pages when the treasury USDC is under the refill threshold', async () => {
    process.env.X402_WALLET_ADDRESS = WALLET;
    configureCdpEnv();
    chain.treasuryAtomic = 4_000_000n; // $4 < default $10
    const result = await runX402LowBalanceCheck();
    expect(result.low).toBe(true);
  });

  it('reports the custodian and flags an X402_WALLET_ADDRESS that is not the wallet the signer holds', async () => {
    process.env.X402_WALLET_ADDRESS = WALLET;
    signerWalletMock.mockResolvedValue({ provider: 'circle', configured: true, address: '0x3333333333333333333333333333333333333333' });
    const result = await runX402LowBalanceCheck();
    expect(result.signerProvider).toBe('circle');
    expect(result.addressMismatch).toBe(true);
    const { log } = jest.requireMock('../../infrastructure/logging') as { log: { error: jest.Mock } };
    expect(log.error.mock.calls.some(([ctx]) => ctx?.event === 'x402_wallet_address_mismatch')).toBe(true);

    signerWalletMock.mockResolvedValue({ provider: 'circle', configured: true, address: WALLET.toUpperCase().replace('0X', '0x') });
    expect((await runX402LowBalanceCheck()).addressMismatch).toBe(false);
  });

  it('carries on when the signer cannot be read, reporting it unknown rather than matching', async () => {
    process.env.X402_WALLET_ADDRESS = WALLET;
    signerWalletMock.mockRejectedValue(new Error('x402 signer wallet read failed: 503'));
    const result = await runX402LowBalanceCheck();
    expect(result.addressMismatch).toBeUndefined();
    expect(result.signerAddress).toBeUndefined();
    expect(result.low).toBe(false);
  });

  it('under the Circle custodian the wallet itself is the float, whatever CDP env is mounted', async () => {
    process.env.X402_WALLET_ADDRESS = WALLET;
    configureCdpEnv();
    signerWalletMock.mockResolvedValue({ provider: 'circle', configured: true, address: WALLET });
    chain.balanceAtomic = 430_000n;     // the Circle wallet at $0.43
    chain.treasuryAtomic = 0n;          // the CDP treasury: irrelevant
    const result = await runX402LowBalanceCheck();
    expect(result.signerProvider).toBe('circle');
    expect(result.skipped).toBeUndefined();
    expect(result.treasuryBalanceUsd).toBeUndefined();
    expect(result.spendingBalanceUsd).toBeCloseTo(0.43, 6);
    expect(result.low).toBe(true);
  });

  it('pages when the treasury ETH gas tank is dust', async () => {
    process.env.X402_WALLET_ADDRESS = WALLET;
    configureCdpEnv();
    chain.ethWei = 10n ** 13n; // 0.00001 ETH < default 0.0001
    const result = await runX402LowBalanceCheck();
    expect(result.low).toBe(true);
  });
});

describe('reload', () => {
  it('stands down under the Circle custodian instead of refusing on a treasury that does not exist', async () => {
    process.env.X402_WALLET_ADDRESS = WALLET;
    configureCdpEnv();
    signerWalletMock.mockResolvedValue({ provider: 'circle', configured: true, address: WALLET });
    chain.balanceAtomic = 430_000n; // under the $1 reload threshold
    chain.treasuryAtomic = 0n;
    const result = await runX402Reload();
    expect(result).toEqual({ skipped: 'circle_float', spendingBalanceUsd: 0.43 });
    expect(transferMock).not.toHaveBeenCalled();
    const { log } = jest.requireMock('../../infrastructure/logging') as { log: { error: jest.Mock; info: jest.Mock } };
    expect(log.error.mock.calls.some(([ctx]) => ctx?.event === 'x402_treasury_short')).toBe(false);
    expect(log.info.mock.calls.some(([ctx]) => ctx?.event === 'x402_reload_not_applicable')).toBe(true);
  });

  it('reports skipped before the wallet or the CDP env exist', async () => {
    await expect(runX402Reload()).resolves.toEqual({ skipped: 'wallet_not_configured' });
    process.env.X402_WALLET_ADDRESS = WALLET;
    await expect(runX402Reload()).resolves.toEqual({ skipped: 'cdp_not_configured' });
    expect(transferMock).not.toHaveBeenCalled();
  });

  it('does nothing while the spending wallet is above the threshold', async () => {
    process.env.X402_WALLET_ADDRESS = WALLET;
    configureCdpEnv();
    chain.balanceAtomic = 3_000_000n; // $3 >= default $1
    const result = await runX402Reload();
    expect(result.reloaded).toBe(false);
    expect(transferMock).not.toHaveBeenCalled();
  });

  it('reloads $5 from the treasury when the spending wallet dips under $1', async () => {
    process.env.X402_WALLET_ADDRESS = WALLET;
    configureCdpEnv();
    chain.balanceAtomic = 400_000n; // $0.40
    const result = await runX402Reload(new Date((GENESIS_TS + 3 * 86_400) * 1000));
    expect(result.reloaded).toBe(true);
    expect(result.transactionHash).toBe('0xreload');
    expect(transferMock).toHaveBeenCalledWith({
      to: WALLET,
      amount: 5_000_000n,
      token: 'usdc',
      network: 'base',
    });
  });

  it('refuses past the per-day pump bound, measured from the chain', async () => {
    process.env.X402_WALLET_ADDRESS = WALLET;
    process.env.X402_RELOAD_MAX_PER_DAY = '2';
    configureCdpEnv();
    chain.balanceAtomic = 400_000n;
    // Each getLogs chunk answers one prior reload; a day spans many chunks,
    // so the measured count trips the cap of 2.
    chain.logsPerChunk = [{ data: '0x' + (5_000_000).toString(16) }];
    const result = await runX402Reload(new Date((GENESIS_TS + 3 * 86_400) * 1000));
    expect(result.capped).toBe(true);
    expect(transferMock).not.toHaveBeenCalled();
  });

  it('refuses when the treasury cannot cover one reload', async () => {
    process.env.X402_WALLET_ADDRESS = WALLET;
    configureCdpEnv();
    chain.balanceAtomic = 400_000n;
    chain.treasuryAtomic = 3_000_000n; // $3 < $5
    const result = await runX402Reload(new Date((GENESIS_TS + 3 * 86_400) * 1000));
    expect(result.treasuryShort).toBe(true);
    expect(transferMock).not.toHaveBeenCalled();
  });

  it('stands down (200 skipped, not a page) while the float has never been funded', async () => {
    process.env.X402_WALLET_ADDRESS = WALLET;
    configureCdpEnv();
    chain.balanceAtomic = 0n;
    chain.treasuryAtomic = 0n;
    chain.ethWei = 0n;
    const reload = await runX402Reload(new Date((GENESIS_TS + 3 * 86_400) * 1000));
    expect(reload.skipped).toBe('treasury_unfunded');
    expect(transferMock).not.toHaveBeenCalled();
    const check = await runX402LowBalanceCheck();
    expect(check.skipped).toBe('treasury_unfunded');
    expect(check.low).toBeUndefined();
  });

  it('a funded-then-drained treasury is NOT the unfunded state — gas remains, and it pages', async () => {
    process.env.X402_WALLET_ADDRESS = WALLET;
    configureCdpEnv();
    chain.balanceAtomic = 0n;
    chain.treasuryAtomic = 0n;
    chain.ethWei = 10n ** 14n; // gas dust survives a USDC drain
    const check = await runX402LowBalanceCheck();
    expect(check.skipped).toBeUndefined();
    expect(check.low).toBe(true);
  });
});

describe('on-chain outbound sum', () => {
  it('sums the Transfer logs where the wallet is the sender', async () => {
    chain.logsPerChunk = [{ data: '0x' + (11_000).toString(16) }]; // $0.011 per chunk
    const { totalUsd, transferCount } = await sumOutboundUsdcUsd(
      WALLET, GENESIS_TS + 10_000, GENESIS_TS + 30_000,
    );
    // [ts+10000, ts+30000) → blocks [5000, 15000) → five 2k chunks (the
    // public RPC's own eth_getLogs range limit).
    expect(transferCount).toBe(5);
    expect(totalUsd).toBeCloseTo(0.055, 9);
    const logCalls = (global.fetch as jest.Mock).mock.calls
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)))
      .filter((b) => b.method === 'eth_getLogs');
    expect(logCalls).toHaveLength(5);
    // The from-address rides as the padded second topic.
    expect(logCalls[0].params[0].topics[1]).toBe('0x' + WALLET.slice(2).padStart(64, '0'));
  });
});

describe('reconciliation', () => {
  it('reports skipped before the wallet is configured', async () => {
    await expect(runX402Reconciliation()).resolves.toEqual({ skipped: 'wallet_not_configured' });
    expect(mockLedgerQuery).not.toHaveBeenCalled();
  });

  it('reconciles when chain and ledger agree within tolerance', async () => {
    process.env.X402_WALLET_ADDRESS = WALLET;
    chain.logsPerChunk = [{ data: '0x' + (11_000).toString(16) }];
    // The fake day spans many chunks; count them from the call log afterwards.
    mockLedgerQuery.mockImplementation(async () => {
      const logCalls = (global.fetch as jest.Mock).mock.calls
        .map(([, init]) => JSON.parse(String((init as RequestInit).body)))
        .filter((b) => b.method === 'eth_getLogs').length;
      return { rows: [{ total: String(logCalls * 0.011), rows: String(logCalls) }] };
    });
    const result = await runX402Reconciliation(new Date((GENESIS_TS + 3 * 86_400) * 1000));
    expect(result.drifted).toBe(false);
    expect(result.onChainUsd).toBeCloseTo(result.ledgerUsd as number, 6);
  });

  it('sets a prepaid token purchase aside on the chain side, and reconciles the tokens\' draw-down on its own line', async () => {
    process.env.X402_WALLET_ADDRESS = WALLET;
    chain.logsPerChunk = [{ data: '0x' + (1_000_000).toString(16) }]; // $1/chunk on-chain
    // Count the chunks the fake day spans, as the agreeing case does.
    let chunks = 0;
    mockLedgerQuery.mockImplementation(async (sql: string) => {
      if (String(sql).includes("connector = $1")) return { rows: [{ total: '3.5' }] };
      chunks = (global.fetch as jest.Mock).mock.calls
        .map(([, init]) => JSON.parse(String((init as RequestInit).body)))
        .filter((b) => b.method === 'eth_getLogs').length;
      // The ledger booked every chunk's dollar except the ten that were a token purchase.
      return { rows: [{ total: String(chunks - 10), rows: String(chunks - 10) }] };
    });
    mockPoolQuery.mockImplementation(async (sql: string) =>
      String(sql).includes('SUM(purchased_usd - balance_usd)')
        ? { rows: [{ vendor: 'apify', drawn: '3.5', since: new Date('2026-09-10T00:00:00Z'), n: '1' }] }
        : { rows: [{ total: '10', n: '1' }] });
    const result = await runX402Reconciliation(new Date((GENESIS_TS + 3 * 86_400) * 1000));
    expect(result.prepaidPurchasesUsd).toBe(10);
    expect(result.prepaidPurchases).toBe(1);
    expect(result.drifted).toBe(false);
    expect(result.prepaid).toEqual({ drawnUsd: 3.5, bookedUsd: 3.5, liveTokens: 1, driftUsd: 0, drifted: false });
  });

  it('flags a token draw-down the ledger did not book', async () => {
    process.env.X402_WALLET_ADDRESS = WALLET;
    chain.logsPerChunk = [];
    mockLedgerQuery.mockImplementation(async (sql: string) =>
      String(sql).includes("connector = $1") ? { rows: [{ total: '1' }] } : { rows: [{ total: '0', rows: '0' }] });
    mockPoolQuery.mockImplementation(async (sql: string) =>
      String(sql).includes('SUM(purchased_usd - balance_usd)')
        ? { rows: [{ vendor: 'apify', drawn: '4', since: new Date('2026-09-10T00:00:00Z'), n: '1' }] }
        : { rows: [{ total: null, n: '0' }] });
    const result = await runX402Reconciliation(new Date((GENESIS_TS + 3 * 86_400) * 1000));
    expect(result.drifted).toBe(false);
    expect(result.prepaid).toMatchObject({ drawnUsd: 4, bookedUsd: 1, drifted: true });
    const { log } = jest.requireMock('../../infrastructure/logging') as { log: { error: jest.Mock } };
    expect(log.error.mock.calls.some(([ctx]) => ctx?.event === 'x402_prepaid_drawdown_drift')).toBe(true);
  });

  it('flags drift when the ledger misses money that left the wallet', async () => {
    process.env.X402_WALLET_ADDRESS = WALLET;
    chain.logsPerChunk = [{ data: '0x' + (1_000_000).toString(16) }]; // $1/chunk on-chain
    mockLedgerQuery.mockResolvedValue({ rows: [{ total: '0', rows: '0' }] });
    const result = await runX402Reconciliation(new Date((GENESIS_TS + 3 * 86_400) * 1000));
    expect(result.drifted).toBe(true);
    expect(result.driftUsd).toBeGreaterThan(0.01);
  });
});
