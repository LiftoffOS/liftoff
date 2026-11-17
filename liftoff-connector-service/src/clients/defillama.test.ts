// The DeFi data rung: each function reads its own host and path, SHAPES the
// vendor's enormous document down to the fields its capability is about, and
// bounds every list and series. Fixtures are the real response shapes, cut to
// a few records (the live documents run to tens of megabytes).

const calls: Array<{ method: string; url: string }> = [];
let script: Array<{ status: number; body: unknown; json?: boolean }> = [];
jest.mock('./connector-transport.js', () => ({
  DEFAULT_PUBLIC_WEB_HEADERS: { 'User-Agent': 'test' },
  makePublicWebTransport: () => async (req: { method: string; url: string }) => {
    calls.push({ method: req.method, url: req.url });
    const next = script.shift() ?? { status: 500, body: { error: 'unscripted' } };
    return {
      ok: next.status < 400,
      status: next.status,
      json: async () => {
        if (next.json === false) throw new Error('not json');
        return next.body;
      },
    } as unknown as Response;
  },
}));
jest.mock('../rpc/execute-dispatcher.js', () => ({ registerConnectorExecutor: jest.fn() }));

import { defillamaExecutor } from './defillama.js';

function run(functionName: string, input: Record<string, unknown> = {}) {
  return defillamaExecutor({ functionName, input } as never);
}

const PROTOCOLS = [
  { name: 'Aave V3', symbol: 'AAVE', category: 'Lending', chains: ['Ethereum', 'Base'], tvl: 30, change_1d: 1.5, change_7d: -2, mcap: 4000, url: 'https://aave.com', slug: 'aave-v3' },
  { name: 'Lido', symbol: 'LDO', category: 'Liquid Staking', chains: ['Ethereum'], tvl: 50, url: 'https://lido.fi' },
  { name: 'Spark', symbol: '-', category: 'Lending', chains: ['Ethereum'], tvl: 10 },
  { name: 'JupSol', symbol: 'JUP', category: 'Lending', chains: ['Solana'], tvl: 99 },
];

beforeEach(() => { calls.length = 0; script = []; });

describe('protocol and chain value locked', () => {
  it('filters the protocol list by chain and category, sorts by value and bounds it', async () => {
    script = [{ status: 200, body: PROTOCOLS }];
    const out = await run('defi_protocols_search', { chain: 'ethereum', category: 'lending', limit: 1 });
    expect(calls[0]).toEqual({ method: 'GET', url: 'https://api.llama.fi/protocols' });
    expect(out.result).toEqual({
      protocols: [{ name: 'Aave V3', symbol: 'AAVE', category: 'Lending', chains: ['Ethereum', 'Base'], tvl_usd: 30, change_1d_pct: 1.5, change_7d_pct: -2, market_cap_usd: 4000, url: 'https://aave.com', slug: 'aave-v3' }],
      matched: 2,
      total_protocols: 4,
    });
    expect(out.costUsd).toBe(0);
    expect(out.failure).toBeUndefined();
  });

  it('matches a name or a symbol, and drops the placeholder symbol', async () => {
    script = [{ status: 200, body: PROTOCOLS }];
    const out = await run('defi_protocols_search', { query: 'spark' });
    const rows = (out.result as { protocols: Array<Record<string, unknown>> }).protocols;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({ name: 'Spark', category: 'Lending', chains: ['Ethereum'], tvl_usd: 10 });
  });

  it('reads one protocol\'s current value as a number', async () => {
    script = [{ status: 200, body: 19589903253.25 }];
    const out = await run('defi_protocol_tvl', { protocol: 'Aave V3' });
    expect(calls[0].url).toBe('https://api.llama.fi/tvl/aave-v3');
    expect(out.result).toEqual({ protocol: 'Aave V3', tvl_usd: 19589903253.25 });
  });

  it('shapes a protocol document into a profile, never its whole history', async () => {
    script = [{ status: 200, body: {
      name: 'Lido', symbol: 'LDO', category: 'Liquid Staking', description: 'x'.repeat(600), url: 'https://lido.fi',
      chains: ['Ethereum', 'Polygon'], currentChainTvls: { Ethereum: 40, Polygon: 2, 'Ethereum-staking': 0 },
      tvl: [{ date: 1, totalLiquidityUSD: 10 }, { date: 2, totalLiquidityUSD: 42 }],
      mcap: 900,
    } }];
    const out = await run('defi_protocol_profile', { protocol: 'lido' });
    const r = out.result as Record<string, unknown>;
    expect(r.tvl_usd).toBe(42);
    expect(r.tvl_by_chain).toEqual([{ chain: 'Ethereum', tvl_usd: 40 }, { chain: 'Polygon', tvl_usd: 2 }]);
    expect(String(r.description)).toHaveLength(401);
    expect(r.history_points_available).toBe(2);
    expect(JSON.stringify(r)).not.toContain('totalLiquidityUSD');
  });

  it('returns the newest points of a protocol series, oldest first', async () => {
    script = [{ status: 200, body: { name: 'Aave', tvl: [{ date: 1, totalLiquidityUSD: 1 }, { date: 2, totalLiquidityUSD: 2 }, { date: 3, totalLiquidityUSD: 3 }] } }];
    const out = await run('defi_protocol_tvl_history', { protocol: 'aave', points: 2 });
    expect(out.result).toEqual({ protocol: 'Aave', points: [{ date: 2, tvl_usd: 2 }, { date: 3, tvl_usd: 3 }], points_available: 3 });
  });

  it('sorts the chains by value and bounds them, and reads one chain\'s series', async () => {
    script = [{ status: 200, body: [{ name: 'Base', tvl: 5, tokenSymbol: 'ETH' }, { name: 'Ethereum', tvl: 50, tokenSymbol: 'ETH' }] }];
    expect((await run('defi_chains_tvl', { limit: 1 })).result).toEqual({ chains: [{ chain: 'Ethereum', tvl_usd: 50, token: 'ETH' }], total_chains: 2 });
    script = [{ status: 200, body: [{ date: 1, tvl: 1 }, { date: 2, tvl: 2 }] }];
    const out = await run('defi_chain_tvl_history', { chain: 'Base', points: 1 });
    expect(calls[1].url).toBe('https://api.llama.fi/v2/historicalChainTvl/Base');
    expect(out.result).toEqual({ chain: 'Base', points: [{ date: 2, tvl_usd: 2 }], points_available: 2 });
  });
});

describe('token prices', () => {
  it('reads the price host with the ids joined, and projects each coin', async () => {
    script = [{ status: 200, body: { coins: { 'coingecko:ethereum': { price: 2750.5, symbol: 'ETH', timestamp: 17, confidence: 0.99, decimals: 18 } } } }];
    const out = await run('token_prices_current', { coins: ['coingecko:ethereum', 'ethereum:0xA0b8'] });
    expect(calls[0].url).toBe('https://coins.llama.fi/prices/current/coingecko%3Aethereum,ethereum%3A0xA0b8');
    expect(out.result).toEqual({ prices: { 'coingecko:ethereum': { price_usd: 2750.5, symbol: 'ETH', at: 17, confidence: 0.99 } } });
  });

  it('takes a comma-separated string too, and reads the change on its own host path', async () => {
    script = [{ status: 200, body: { coins: { 'coingecko:ethereum': 0.5 } } }];
    const out = await run('token_price_change', { coins: 'coingecko:ethereum, coingecko:bitcoin' });
    expect(calls[0].url).toBe('https://coins.llama.fi/percentage/coingecko%3Aethereum,coingecko%3Abitcoin');
    expect(out.result).toEqual({ changes_pct: { 'coingecko:ethereum': 0.5 } });
  });

  it('refuses without ids, naming what one looks like, and calls nothing', async () => {
    const out = await run('token_prices_current', {});
    expect(out.failure?.message).toMatch(/coins is required/);
    expect(calls).toHaveLength(0);
  });
});

describe('stablecoins and yields', () => {
  it('sorts stablecoins by circulating supply and reads the peg and mechanism', async () => {
    script = [{ status: 200, body: { peggedAssets: [
      { name: 'USDC', symbol: 'USDC', pegType: 'peggedUSD', pegMechanism: 'fiat-backed', circulating: { peggedUSD: 40 }, price: 1 },
      { name: 'Tether', symbol: 'USDT', pegType: 'peggedUSD', pegMechanism: 'fiat-backed', circulating: { peggedUSD: 180 }, price: 0.999 },
    ] } }];
    const out = await run('stablecoins_list', { limit: 1 });
    expect(calls[0].url).toBe('https://stablecoins.llama.fi/stablecoins?includePrices=true');
    expect(out.result).toEqual({ stablecoins: [{ name: 'Tether', symbol: 'USDT', peg: 'peggedUSD', mechanism: 'fiat-backed', circulating_usd: 180, price: 0.999 }], total: 2 });
  });

  it('totals stablecoin supply per chain, largest first', async () => {
    script = [{ status: 200, body: [{ name: 'Tron', totalCirculatingUSD: { peggedUSD: 94 } }, { name: 'Ethereum', totalCirculatingUSD: { peggedUSD: 140, peggedEUR: 6 } }] }];
    expect((await run('stablecoin_supply_by_chain', { limit: 2 })).result).toEqual({
      chains: [{ chain: 'Ethereum', circulating_usd: 146 }, { chain: 'Tron', circulating_usd: 94 }],
      total_chains: 2,
    });
  });

  it('filters pools by chain, project, token and size, and sorts by yield', async () => {
    script = [{ status: 200, body: { data: [
      { chain: 'Ethereum', project: 'aave-v3', symbol: 'USDC', tvlUsd: 20_000_000, apy: 5, apyBase: 4, apyReward: 1, stablecoin: true, ilRisk: 'no', pool: 'p1' },
      { chain: 'Ethereum', project: 'aave-v3', symbol: 'USDC', tvlUsd: 100, apy: 90, pool: 'small' },
      { chain: 'Solana', project: 'kamino', symbol: 'USDC', tvlUsd: 50_000_000, apy: 9, pool: 'p2' },
    ] } }];
    const out = await run('yield_pools_search', { chain: 'Ethereum', project: 'aave-v3', symbol: 'usdc', min_tvl_usd: 1_000_000, limit: 5 });
    expect(calls[0].url).toBe('https://yields.llama.fi/pools');
    expect(out.result).toEqual({
      pools: [{ chain: 'Ethereum', project: 'aave-v3', symbol: 'USDC', tvl_usd: 20_000_000, apy_pct: 5, apy_base_pct: 4, apy_reward_pct: 1, stablecoin: true, risk_impermanent_loss: 'no', pool_id: 'p1' }],
      matched: 1,
      total_pools: 3,
    });
  });
});

describe('exchange volume and protocol fees', () => {
  it('asks the source to leave the charts out, and sorts the protocols by the day', async () => {
    script = [{ status: 200, body: { total24h: 100, total7d: 700, change_1d: 4, protocols: [
      { name: 'Uniswap V3', category: 'Dexes', chains: ['Ethereum'], total24h: 10, total7d: 70, total30d: 300, change_1d: 2 },
      { name: 'PancakeSwap', category: 'Dexes', chains: ['BSC'], total24h: 40, total7d: 280 },
    ] } }];
    const out = await run('dex_volume_overview', { chain: 'Ethereum', limit: 1 });
    expect(calls[0].url).toBe('https://api.llama.fi/overview/dexs/Ethereum?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true');
    expect(out.result).toEqual({
      chain: 'Ethereum',
      total_24h_usd: 100,
      total_7d_usd: 700,
      change_1d_pct: 4,
      protocols: [{ name: 'PancakeSwap', category: 'Dexes', chains: ['BSC'], volume_24h_usd: 40, volume_7d_usd: 280 }],
      total_protocols: 2,
    });
  });

  it('reads one exchange\'s volume with a bounded daily series', async () => {
    script = [{ status: 200, body: { name: 'Uniswap', category: 'Dexes', chains: ['Ethereum'], total24h: 10, total7d: 70, total30d: 300, totalAllTime: 9000, change_1d: 1, totalDataChart: [[1, 5], [2, 6], [3, 7]] } }];
    const out = await run('dex_protocol_volume', { protocol: 'Uniswap', points: 2 });
    expect(calls[0].url).toBe('https://api.llama.fi/summary/dexs/uniswap?excludeTotalDataChartBreakdown=true');
    expect(out.result).toMatchObject({
      protocol: 'Uniswap',
      volume_24h_usd: 10,
      volume_all_time_usd: 9000,
      daily_points: [{ date: 2, volume_usd: 6 }, { date: 3, volume_usd: 7 }],
      points_available: 3,
    });
  });

  it('names fees and revenue on the fee routes, not volume', async () => {
    script = [{ status: 200, body: { total24h: 89, protocols: [{ name: 'Tether', category: 'Stablecoins', total24h: 30, total7d: 200, revenue24h: 29 }] } }];
    const overview = await run('protocol_fees_overview', {});
    expect(calls[0].url).toBe('https://api.llama.fi/overview/fees?excludeTotalDataChart=true&excludeTotalDataChartBreakdown=true');
    expect(overview.result).toMatchObject({ protocols: [{ name: 'Tether', fees_24h_usd: 30, fees_7d_usd: 200, revenue_24h_usd: 29 }] });
    script = [{ status: 200, body: { name: 'Aave', total24h: 5, revenue24h: 1, totalDataChart: [[1, 5]] } }];
    const one = await run('protocol_fees', { protocol: 'aave' });
    expect(one.result).toMatchObject({ protocol: 'Aave', fees_24h_usd: 5, revenue_24h_usd: 1, daily_points: [{ date: 1, fees_usd: 5 }] });
  });
});

describe('what it says when it cannot answer', () => {
  it('reads a name the source does not know as that, whichever code it answers with', async () => {
    for (const status of [400, 404]) {
      script = [{ status, body: {} }];
      const out = await run('defi_protocol_tvl', { protocol: 'no-such-protocol' });
      expect(out.failure?.message).toMatch(/has no record under that name/);
      expect(out.result).toEqual({});
    }
  });

  it('reads a rate limit as one, and any other code as itself', async () => {
    script = [{ status: 429, body: {} }];
    expect((await run('defi_chains_tvl')).failure?.message).toMatch(/rate-limiting/);
    script = [{ status: 503, body: {} }];
    expect((await run('defi_chains_tvl')).failure?.message).toMatch(/HTTP 503/);
  });

  it('reads a body that is not JSON as that, and names an unknown tool', async () => {
    script = [{ status: 200, body: null, json: false }];
    expect((await run('defi_chains_tvl')).failure?.message).toMatch(/not JSON/);
    expect((await run('defi_moon_phase')).failure?.message).toMatch(/no tool named defi_moon_phase/);
    expect(calls).toHaveLength(1);
  });

  it('books no charge and no vendor call on a refusal', async () => {
    const out = await run('defi_protocol_profile', {});
    expect(out.failure?.message).toMatch(/protocol is required/);
    expect(out.costUsd).toBeUndefined();
  });
});
