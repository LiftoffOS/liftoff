// The Apify prepaid float: who buys a token, what it costs, how many times a
// day, and what it retires. The table is a scripted pool, the purchase a
// mocked connector-service call, the vendor's balance endpoint a scripted
// fetch. Every "how many today" and every balance is read, never tallied.
//
// WHO BUYS is the thing most of these pin. Apify has no per-run rail, its
// x402 support sells prepaid tokens, and Locus's one Apify entry buys the
// same token — so Locus is the purchaser and the x402 wallet is an emergency
// lever behind a flag. Wallet-first is how a $1 wallet-bought token came to
// be the only one in play while a Locus-funded one sat unused.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const poolQuery = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ query: poolQuery }),
  withAdminScope: jest.fn(),
  withTenantScope: jest.fn(),
}));

const purchaseMock = jest.fn();
jest.mock('../../connectors/connector-service-client', () => ({
  purchaseX402PrepaidToken: (...a: unknown[]) => purchaseMock(...a),
}));

const walletBalanceMock = jest.fn(async () => 25);
jest.mock('../x402-wallet-service', () => ({
  x402WalletAddress: () => process.env.X402_WALLET_ADDRESS?.toLowerCase(),
  getX402WalletBalanceUsd: () => walletBalanceMock(),
}));

const secrets = new Map<string, string>();
jest.mock('../platform-prepaid-secret', () => ({
  putPlatformPrepaidSecret: jest.fn(async (vendor: string, id: string, token: string) => {
    const name = `platform-prepaid-${vendor}-${id}`;
    secrets.set(name, token);
    return name;
  }),
  readPlatformPrepaidSecret: jest.fn(async (name: string) => secrets.get(name) ?? null),
  destroyPlatformPrepaidSecret: jest.fn(async (name: string) => { secrets.delete(name); }),
}));

import {
  ensureApifyPrepaidToken,
  getLiveApifyPrepaidToken,
  listApifyPrepaidTokensForReads,
  refreshApifyPrepaidBalance,
} from '../apify-prepaid-token-service';

const NOW = new Date('2026-09-19T12:00:00Z');
const WALLET = '0x1111111111111111111111111111111111111111';

interface Row {
  id: string; secret_name: string; purchased_usd: string; balance_usd: string; purchased_at: Date; expires_at: Date; retired_at?: Date | null; funded_by?: string;
}

let rows: Row[] = [];
const realFetch = global.fetch;

function liveRow(over: Partial<Row> = {}): Row {
  const id = over.id ?? 'p-1';
  const name = `platform-prepaid-apify-${id}`;
  secrets.set(name, `apify_api_${id}`);
  return {
    id, secret_name: name, purchased_usd: '10', balance_usd: '8',
    purchased_at: new Date('2026-09-15T00:00:00Z'), expires_at: new Date('2026-09-29T00:00:00Z'), retired_at: null,
    ...over,
  };
}

/** A small SQL-shaped script over `rows`, enough for the service's queries. */
function scriptPool(): void {
  poolQuery.mockImplementation(async (sql: string, params: unknown[] = []) => {
    const q = String(sql);
    const live = rows.filter((r) => !r.retired_at);
    if (q.includes('COUNT(*) AS n')) {
      const since = params[1] as Date | undefined;
      return { rows: [{ n: String(rows.filter((r) => since === undefined || r.purchased_at >= since).length) }] };
    }
    if (q.includes('expires_at <= $2')) {
      return { rows: live.filter((r) => r.expires_at <= (params[1] as Date)) };
    }
    if (q.includes('ORDER BY purchased_at') && q.includes('retired_at IS NULL')) {
      return { rows: live.map((r) => ({ id: r.id, secret_name: r.secret_name })) };
    }
    if (q.includes('ORDER BY expires_at DESC')) {
      // Every live token, newest first — the upkeep reads all of them.
      const after = params[1] as Date;
      return { rows: live.filter((r) => r.expires_at > after).sort((a, b) => b.expires_at.getTime() - a.expires_at.getTime()) };
    }
    if (q.includes('ORDER BY expires_at ASC')) {
      const after = params[1] as Date; const min = params[2] as number;
      return { rows: live.filter((r) => r.expires_at > after && Number(r.balance_usd) >= min).sort((a, b) => a.expires_at.getTime() - b.expires_at.getTime()).slice(0, 1) };
    }
    if (q.startsWith('SELECT') && q.includes('WHERE id = $1 AND retired_at IS NULL')) {
      return { rows: live.filter((r) => r.id === params[0]) };
    }
    if (q.startsWith('UPDATE platform_prepaid_tokens SET balance_usd')) {
      const r = rows.find((x) => x.id === params[0]); if (r) r.balance_usd = String(params[1]);
      return { rows: [] };
    }
    if (q.startsWith('UPDATE platform_prepaid_tokens SET retired_at')) {
      const r = rows.find((x) => x.id === params[0]); if (r && !r.retired_at) r.retired_at = NOW;
      return { rows: [] };
    }
    if (q.startsWith('INSERT INTO platform_prepaid_tokens')) {
      rows.push({ id: params[0] as string, secret_name: params[2] as string, purchased_usd: String(params[3]), balance_usd: String(params[4]), purchased_at: params[5] as Date, expires_at: params[6] as Date, funded_by: (params[8] as string) ?? 'x402_wallet', retired_at: null });
      return { rows: [] };
    }
    throw new Error(`unscripted query: ${q.slice(0, 60)}`);
  });
}

function balanceAnswers(status: number, body: unknown): void {
  global.fetch = jest.fn(async () => ({ ok: status < 400, status, json: async () => body })) as unknown as typeof fetch;
}

/** A purchase that succeeds, with the funder it was asked for. */
function purchaseSucceeds(token: string, balanceUsd = 1): void {
  purchaseMock.mockImplementation(async (input: { funding?: string }) => ({
    purchased: true,
    purchase: { vendor: 'apify', token, balanceUsd, expiresAt: '2026-10-03T12:00:00.000Z', paidUsd: 1, fundedBy: input.funding ?? 'locus' },
  }));
}

beforeEach(() => {
  rows = [];
  secrets.clear();
  poolQuery.mockReset();
  purchaseMock.mockReset();
  walletBalanceMock.mockClear();
  walletBalanceMock.mockResolvedValue(25);
  scriptPool();
  process.env.X402_WALLET_ADDRESS = WALLET;
  delete process.env.APIFY_PREPAID_WALLET_FALLBACK;
  delete process.env.APIFY_PREPAID_MAX_PURCHASES_PER_DAY;
  balanceAnswers(200, { remainingBalanceUsd: 8 });
});

afterEach(() => {
  global.fetch = realFetch;
  delete process.env.X402_WALLET_ADDRESS;
  delete process.env.APIFY_PREPAID_WALLET_FALLBACK;
});

describe('getLiveApifyPrepaidToken', () => {
  it('returns the soonest-expiring live token that covers the minimum, with its secret', async () => {
    rows = [
      liveRow({ id: 'late', expires_at: new Date('2026-09-30T00:00:00Z') }),
      liveRow({ id: 'soon', expires_at: new Date('2026-09-22T00:00:00Z'), balance_usd: '2' }),
      liveRow({ id: 'thin', expires_at: new Date('2026-09-21T00:00:00Z'), balance_usd: '0.1' }),
    ];
    const t = await getLiveApifyPrepaidToken(NOW, 0.5);
    expect(t).toMatchObject({ id: 'soon', token: 'apify_api_soon', balanceUsd: 2 });
  });

  it('is null with no token, and with a token whose secret is gone', async () => {
    expect(await getLiveApifyPrepaidToken(NOW, 0.5)).toBeNull();
    rows = [liveRow({ id: 'orphan' })];
    secrets.delete('platform-prepaid-apify-orphan');
    expect(await getLiveApifyPrepaidToken(NOW, 0.5)).toBeNull();
  });

  it('a token with a dollar on it serves runs down to the ten-cent floor, and the upkeep does not buy over it', async () => {
    rows = [liveRow({ id: 'used-once', balance_usd: '0.99' })];
    expect(await getLiveApifyPrepaidToken(NOW)).toMatchObject({ id: 'used-once', balanceUsd: 0.99 });
    balanceAnswers(200, { remainingBalanceUsd: 0.99 });
    expect(await ensureApifyPrepaidToken(NOW)).toMatchObject({ purchased: false, liveBalanceUsd: 0.99 });
    expect(purchaseMock).not.toHaveBeenCalled();

    rows = [liveRow({ id: 'spent', balance_usd: '0.05' })];
    expect(await getLiveApifyPrepaidToken(NOW)).toBeNull();
  });
});

describe('ensureApifyPrepaidToken — who pays', () => {
  /** A drained, retired earlier purchase: the environment has bought before. */
  function priorPurchase(): Row {
    return liveRow({ id: 'earlier', balance_usd: '0', purchased_at: new Date('2026-08-01T00:00:00Z'), expires_at: new Date('2026-08-15T00:00:00Z'), retired_at: new Date('2026-08-15T00:00:00Z') });
  }

  it('buys through Locus by default, and never reads the wallet at all', async () => {
    purchaseSucceeds('apify_api_locus');
    const out = await ensureApifyPrepaidToken(NOW);
    expect(out).toMatchObject({ purchased: true, amountUsd: 1, fundedBy: 'locus' });
    expect(purchaseMock).toHaveBeenCalledTimes(1);
    expect(purchaseMock).toHaveBeenCalledWith({ vendor: 'apify', amountUsd: 1, funding: 'locus' });
    expect(walletBalanceMock).not.toHaveBeenCalled();
    // The live token it left behind reports its funder to the run that spends it.
    expect(await getLiveApifyPrepaidToken(NOW)).toMatchObject({ token: 'apify_api_locus', fundedBy: 'locus' });
  });

  it('is exactly $1 every time, whatever the wallet holds — it is the monthly ceiling of the account the token IS', async () => {
    purchaseSucceeds('apify_api_one');
    walletBalanceMock.mockResolvedValue(250);
    await ensureApifyPrepaidToken(NOW);
    rows = [priorPurchase()];
    await ensureApifyPrepaidToken(NOW);
    for (const [input] of purchaseMock.mock.calls) expect(input).toMatchObject({ amountUsd: 1 });
    expect(rows.filter((r) => !r.retired_at).every((r) => r.purchased_usd === '1')).toBe(true);
  });

  it('stands down quietly when no Locus connection can pay and the wallet is not an option', async () => {
    purchaseMock.mockResolvedValue({ purchased: false, reason: 'funder_unavailable' });
    expect(await ensureApifyPrepaidToken(NOW)).toMatchObject({ skipped: 'funder_unavailable', purchased: false });
    expect(purchaseMock).toHaveBeenCalledTimes(1);
    expect(purchaseMock).toHaveBeenCalledWith({ vendor: 'apify', amountUsd: 1, funding: 'locus' });
    expect(walletBalanceMock).not.toHaveBeenCalled();
  });

  it("relays Locus's refusal without reaching for the wallet", async () => {
    purchaseMock.mockResolvedValue({ purchased: false, reason: 'vendor_refused' });
    expect(await ensureApifyPrepaidToken(NOW)).toMatchObject({ purchased: false, refused: 'vendor_refused' });
    expect(purchaseMock).toHaveBeenCalledTimes(1);
    expect(walletBalanceMock).not.toHaveBeenCalled();
  });

  it('spends the wallet ONLY behind the emergency flag, only when Locus could not pay, and says so loudly', async () => {
    process.env.APIFY_PREPAID_WALLET_FALLBACK = '1';
    walletBalanceMock.mockResolvedValue(25);
    purchaseMock
      .mockResolvedValueOnce({ purchased: false, reason: 'funder_unavailable' })
      .mockResolvedValueOnce({ purchased: true, purchase: { vendor: 'apify', token: 'apify_api_emergency', balanceUsd: 1, expiresAt: '2026-10-03T12:00:00.000Z', paidUsd: 1, fundedBy: 'x402_wallet' } });

    const out = await ensureApifyPrepaidToken(NOW);
    expect(out).toMatchObject({ purchased: true, amountUsd: 1, fundedBy: 'x402_wallet', walletBalanceUsd: 25 });
    expect(purchaseMock.mock.calls.map(([i]) => (i as { funding: string }).funding)).toEqual(['locus', 'x402_wallet']);
    const { log } = jest.requireMock('../../infrastructure/logging') as { log: { error: jest.Mock } };
    expect(log.error.mock.calls.some(([ctx]) => ctx?.event === 'apify_prepaid_wallet_fallback_used')).toBe(true);
  });

  it('will not spend the wallet with the flag set while the wallet cannot cover the vendor minimum', async () => {
    process.env.APIFY_PREPAID_WALLET_FALLBACK = '1';
    walletBalanceMock.mockResolvedValue(0.4);
    purchaseMock.mockResolvedValue({ purchased: false, reason: 'funder_unavailable' });
    expect(await ensureApifyPrepaidToken(NOW)).toMatchObject({ skipped: 'wallet_unfunded', walletBalanceUsd: 0.4, purchased: false });
    expect(purchaseMock).toHaveBeenCalledTimes(1);
  });

  it('will not spend the wallet with the flag set and no wallet configured', async () => {
    process.env.APIFY_PREPAID_WALLET_FALLBACK = '1';
    delete process.env.X402_WALLET_ADDRESS;
    purchaseMock.mockResolvedValue({ purchased: false, reason: 'funder_unavailable' });
    expect(await ensureApifyPrepaidToken(NOW)).toMatchObject({ skipped: 'wallet_not_configured', purchased: false });
    expect(purchaseMock).toHaveBeenCalledTimes(1);
  });

  it('never asks the wallet while Locus can pay, even with the flag set', async () => {
    process.env.APIFY_PREPAID_WALLET_FALLBACK = '1';
    purchaseSucceeds('apify_api_locus');
    expect(await ensureApifyPrepaidToken(NOW)).toMatchObject({ purchased: true, fundedBy: 'locus' });
    expect(purchaseMock).toHaveBeenCalledTimes(1);
    expect(walletBalanceMock).not.toHaveBeenCalled();
  });

  it('buys a token with no wallet configured at all — the wallet is not what funds Apify', async () => {
    delete process.env.X402_WALLET_ADDRESS;
    purchaseSucceeds('apify_api_locus');
    expect(await ensureApifyPrepaidToken(NOW)).toMatchObject({ purchased: true, fundedBy: 'locus' });
  });
});

describe('ensureApifyPrepaidToken — the float', () => {
  it('buys the first token when none is live, holds its secret, and records the purchase from the vendor\'s own figures', async () => {
    purchaseMock.mockResolvedValue({ purchased: true, purchase: { vendor: 'apify', token: 'apify_api_new', balanceUsd: 1, expiresAt: '2026-10-03T12:00:00.000Z', paidUsd: 1, transaction: '0xtx', fundedBy: 'locus' } });
    const out = await ensureApifyPrepaidToken(NOW);
    expect(out).toMatchObject({ retiredExpired: 0, refreshed: 0, purchased: true, amountUsd: 1, expiresAt: '2026-10-03T12:00:00.000Z', purchasesToday: 1 });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ purchased_usd: '1', balance_usd: '1', funded_by: 'locus' });
    expect(secrets.get(rows[0].secret_name)).toBe('apify_api_new');
  });

  it('leaves a healthy live token alone after re-reading its balance from the vendor', async () => {
    rows = [liveRow({ balance_usd: '3' })];
    balanceAnswers(200, { remainingBalanceUsd: 7.25 });
    const out = await ensureApifyPrepaidToken(NOW);
    expect(out).toMatchObject({ purchased: false, liveBalanceUsd: 7.25, refreshed: 1 });
    expect(rows[0].balance_usd).toBe('7.25');
    expect(purchaseMock).not.toHaveBeenCalled();
  });

  it('re-reads EVERY live token, not just the newest — the executor spends the soonest-expiring', async () => {
    // The defect: the upkeep refreshed `ORDER BY expires_at DESC LIMIT 1` and
    // the executor took `ORDER BY expires_at ASC`, so the two never looked at
    // the same token and an overdrawn one stayed live indefinitely.
    rows = [
      liveRow({ id: 'newest', expires_at: new Date('2026-09-30T00:00:00Z'), balance_usd: '1' }),
      liveRow({ id: 'oldest', expires_at: new Date('2026-09-21T00:00:00Z'), balance_usd: '0.122' }),
    ];
    balanceAnswers(200, { remainingBalanceUsd: -0.2206 });
    // Nobody can fund the replacement, so what is left on the table is only
    // what the refreshes did.
    purchaseMock.mockResolvedValue({ purchased: false, reason: 'funder_unavailable' });
    const out = await ensureApifyPrepaidToken(NOW);
    expect(out.refreshed).toBe(2);
    // Both are overdrawn by that answer, so both are retired and the float
    // buys again rather than handing a run a dead token.
    expect(rows.every((r) => r.retired_at)).toBe(true);
    expect(rows.every((r) => r.balance_usd === '0')).toBe(true);
    expect(await getLiveApifyPrepaidToken(NOW)).toBeNull();
  });

  it('buys on demand past a healthy live token only when forced, still under the per-day cap', async () => {
    rows = [liveRow({ balance_usd: '8' })];
    purchaseSucceeds('apify_api_forced');
    expect(await ensureApifyPrepaidToken(NOW)).toMatchObject({ purchased: false });
    expect(purchaseMock).not.toHaveBeenCalled();
    expect(await ensureApifyPrepaidToken(NOW, { force: true })).toMatchObject({ purchased: true, amountUsd: 1 });
    expect(rows).toHaveLength(2);
  });

  it('buys the next token when the live one is nearly spent, or a day from expiry', async () => {
    purchaseSucceeds('apify_api_next');
    rows = [liveRow({ id: 'thin' })];
    balanceAnswers(200, { remainingBalanceUsd: 0.05 });
    expect(await ensureApifyPrepaidToken(NOW)).toMatchObject({ purchased: true });

    rows = [liveRow({ id: 'expiring', expires_at: new Date('2026-09-20T06:00:00Z') })];
    balanceAnswers(200, { remainingBalanceUsd: 9 });
    expect(await ensureApifyPrepaidToken(NOW)).toMatchObject({ purchased: true, liveBalanceUsd: 9 });
  });

  it('refuses to buy past the per-day cap, counted from the table', async () => {
    rows = [
      liveRow({ id: 'a', purchased_at: new Date('2026-09-19T01:00:00Z'), balance_usd: '0.02' }),
      liveRow({ id: 'b', purchased_at: new Date('2026-09-19T02:00:00Z'), balance_usd: '0.02', expires_at: new Date('2026-10-03T02:00:00Z') }),
    ];
    balanceAnswers(200, { remainingBalanceUsd: 0.02 });
    const out = await ensureApifyPrepaidToken(NOW);
    expect(out).toMatchObject({ purchased: false, capped: true, purchasesToday: 2 });
    expect(purchaseMock).not.toHaveBeenCalled();
  });

  it('relays the funder\'s refusal without inventing a token', async () => {
    purchaseMock.mockResolvedValue({ purchased: false, reason: 'daily_ceiling' });
    const out = await ensureApifyPrepaidToken(NOW);
    expect(out).toMatchObject({ purchased: false, refused: 'daily_ceiling' });
    expect(rows).toHaveLength(0);
  });

  it('retires an expired token, destroys its secret, and keeps the unspent remainder on the row', async () => {
    rows = [liveRow({ id: 'old', expires_at: new Date('2026-09-19T11:00:00Z'), balance_usd: '2.5' })];
    purchaseSucceeds('apify_api_fresh');
    const out = await ensureApifyPrepaidToken(NOW);
    expect(out).toMatchObject({ retiredExpired: 1, purchased: true });
    expect(rows[0].retired_at).toBeTruthy();
    expect(rows[0].balance_usd).toBe('2.5');
    expect(secrets.has('platform-prepaid-apify-old')).toBe(false);
    const { log } = jest.requireMock('../../infrastructure/logging') as { log: { info: jest.Mock } };
    expect(log.info.mock.calls.some(([ctx]) => ctx?.event === 'x402_prepaid_expired_unspent' && ctx.unspentUsd === 2.5)).toBe(true);
  });
});

describe('refreshApifyPrepaidBalance', () => {
  it('writes the vendor\'s balance, retires a drained token, and retires one the vendor no longer honours', async () => {
    rows = [liveRow({ id: 'p' })];
    balanceAnswers(200, { data: { remainingBalanceUsd: 5.5 } });
    expect(await refreshApifyPrepaidBalance('p')).toEqual({ balanceUsd: 5.5, retired: false });
    expect(rows[0].balance_usd).toBe('5.5');

    balanceAnswers(200, { remainingBalanceUsd: 0 });
    expect(await refreshApifyPrepaidBalance('p')).toEqual({ balanceUsd: 0, retired: true });
    expect(rows[0].retired_at).toBeTruthy();

    rows = [liveRow({ id: 'q' })];
    balanceAnswers(401, { error: 'invalid token' });
    expect(await refreshApifyPrepaidBalance('q')).toEqual({ balanceUsd: null, retired: true });
    expect(rows[0].retired_at).toBeTruthy();
    expect(secrets.has('platform-prepaid-apify-q')).toBe(false);
  });

  it('hears an OVERDRAWN token, stores it as 0, and retires it — and the next run takes a different one', async () => {
    // Apify does not stop a run at the token's balance: 025902aa finished at
    // -0.2206 against a dollar. Rejecting the figure as out of range left the
    // row reading $0.122 and the token live for run after refused run.
    rows = [
      liveRow({ id: 'overdrawn', balance_usd: '0.122', expires_at: new Date('2026-09-21T00:00:00Z') }),
      liveRow({ id: 'healthy', balance_usd: '1', expires_at: new Date('2026-09-28T00:00:00Z') }),
    ];
    expect(await getLiveApifyPrepaidToken(NOW)).toMatchObject({ id: 'overdrawn' });

    balanceAnswers(200, { remainingBalanceUsd: -0.2206 });
    expect(await refreshApifyPrepaidBalance('overdrawn')).toEqual({ balanceUsd: -0.2206, retired: true });
    // The column requires >= 0, and there is no migration here.
    expect(rows[0].balance_usd).toBe('0');
    expect(rows[0].retired_at).toBeTruthy();
    expect(secrets.has('platform-prepaid-apify-overdrawn')).toBe(false);

    expect(await getLiveApifyPrepaidToken(NOW)).toMatchObject({ id: 'healthy', token: 'apify_api_healthy' });
  });

  it('leaves the row alone on an unreadable or unrecognised answer', async () => {
    rows = [liveRow({ id: 'r', balance_usd: '6' })];
    balanceAnswers(503, {});
    expect(await refreshApifyPrepaidBalance('r')).toEqual({ balanceUsd: null, retired: false });
    balanceAnswers(200, { something: 'else' });
    expect(await refreshApifyPrepaidBalance('r')).toEqual({ balanceUsd: null, retired: false });
    expect(rows[0].balance_usd).toBe('6');
    expect(rows[0].retired_at).toBeFalsy();
  });
});

describe('listApifyPrepaidTokensForReads', () => {
  it('returns every token not yet retired with its secret, expired ones included, skipping a token whose secret is gone', async () => {
    rows = [
      liveRow({ id: 'live' }),
      liveRow({ id: 'expired-not-retired', expires_at: new Date('2026-09-18T00:00:00Z') }),
      liveRow({ id: 'retired', retired_at: new Date('2026-09-10T00:00:00Z') }),
      liveRow({ id: 'orphan' }),
    ];
    secrets.delete('platform-prepaid-apify-orphan');
    const out = await listApifyPrepaidTokensForReads();
    expect(out).toEqual([
      { id: 'live', token: 'apify_api_live', fundedBy: 'x402_wallet' },
      { id: 'expired-not-retired', token: 'apify_api_expired-not-retired', fundedBy: 'x402_wallet' },
    ]);
  });
});
