// FALLBACK-AUTHORED registry functions — DeFi and on-chain market data.
// Basis: the vendor's free, open API across its four hosts (api.llama.fi,
// coins.llama.fi, yields.llama.fi, stablecoins.llama.fi), confirmed live
// 2026-09-22; there is no OpenAPI spec, so these are hand-authored to the
// executor in src/clients/defillama.ts and the two must stay in lock-step
// (each name below is a case there). Keyless public data — internal-tier, no
// vendor account or api key, no per-call charge. All read-only.
//
// The vendor's own documents are megabytes each (a protocol's is 10 MB, the
// fee overview 27 MB), so every function here is shaped by the executor: the
// fields the capability is about, a bounded list, a bounded series. `limit`
// and `points` are the caller's control over that.

import type { ConnectorFunction } from '../../types.js';

const PROTOCOL = { type: 'string', description: 'Protocol name or slug, for example "aave", "uniswap", "lido"' } as const;
const LIMIT = { type: 'integer', description: 'Rows to return, 1-200 (default 25)' } as const;
const POINTS = { type: 'integer', description: 'Daily points to return, newest last, 1-365 (default 90)' } as const;

export const DEFILLAMA_FUNCTIONS: ConnectorFunction[] = [
  {
    name: 'defi_protocols_search',
    description: 'Search DeFi protocols by name, chain or category and return the largest by value locked, with 1-day and 7-day change',
    inputSchema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Name or token symbol to match, for example "aave"' },
        chain: { type: 'string', description: 'Only protocols on this chain, for example "Ethereum", "Arbitrum"' },
        category: { type: 'string', description: 'Only this category, for example "Lending", "Dexes", "Liquid Staking"' },
        limit: LIMIT,
      },
    },
    categories: ['read'],
  },
  {
    name: 'defi_protocol_tvl',
    description: 'The current total value locked in one DeFi protocol, in US dollars',
    inputSchema: { type: 'object', properties: { protocol: PROTOCOL }, required: ['protocol'] },
    categories: ['read'],
  },
  {
    name: 'defi_protocol_profile',
    description: 'What one DeFi protocol is: its category, chains, description, current value locked and how that splits across chains',
    inputSchema: { type: 'object', properties: { protocol: PROTOCOL }, required: ['protocol'] },
    categories: ['read'],
  },
  {
    name: 'defi_protocol_tvl_history',
    description: 'Daily total value locked for one DeFi protocol over time',
    inputSchema: { type: 'object', properties: { protocol: PROTOCOL, points: POINTS }, required: ['protocol'] },
    categories: ['read'],
  },
  {
    name: 'defi_chains_tvl',
    description: 'Total value locked on each blockchain, largest first',
    inputSchema: { type: 'object', properties: { limit: LIMIT } },
    categories: ['read'],
  },
  {
    name: 'defi_chain_tvl_history',
    description: 'Daily total value locked on one blockchain over time',
    inputSchema: {
      type: 'object',
      properties: { chain: { type: 'string', description: 'Chain name, for example "Ethereum", "Solana", "Base"' }, points: POINTS },
      required: ['chain'],
    },
    categories: ['read'],
  },
  {
    name: 'token_prices_current',
    description: 'Current US dollar price of one or more tokens, by id ("coingecko:ethereum") or by chain and contract address ("ethereum:0x…")',
    inputSchema: {
      type: 'object',
      properties: {
        coins: {
          type: 'array',
          items: { type: 'string' },
          description: 'Token ids, at most 50: "coingecko:bitcoin", "ethereum:0xA0b8…", "solana:So111…"',
        },
      },
      required: ['coins'],
    },
    categories: ['read'],
  },
  {
    name: 'token_price_change',
    description: 'Percentage price change of one or more tokens over the past day, by the same ids as the price lookup',
    inputSchema: {
      type: 'object',
      properties: { coins: { type: 'array', items: { type: 'string' }, description: 'Token ids, at most 50' } },
      required: ['coins'],
    },
    categories: ['read'],
  },
  {
    name: 'stablecoins_list',
    description: 'Stablecoins by circulating supply, with the peg, the mechanism behind it and the current price',
    inputSchema: { type: 'object', properties: { limit: LIMIT } },
    categories: ['read'],
  },
  {
    name: 'stablecoin_supply_by_chain',
    description: 'Stablecoin circulating supply on each blockchain, largest first',
    inputSchema: { type: 'object', properties: { limit: LIMIT } },
    categories: ['read'],
  },
  {
    name: 'yield_pools_search',
    description: 'Yield-bearing pools by chain, project or token, with value locked and the base, reward and total annual percentage yield, highest first',
    inputSchema: {
      type: 'object',
      properties: {
        chain: { type: 'string', description: 'Only pools on this chain, for example "Ethereum"' },
        project: { type: 'string', description: 'Only pools of this project, for example "aave-v3", "lido"' },
        symbol: { type: 'string', description: 'Only pools whose token symbol contains this, for example "USDC"' },
        min_tvl_usd: { type: 'integer', description: 'Only pools with at least this much value locked' },
        limit: LIMIT,
      },
    },
    categories: ['read'],
  },
  {
    name: 'dex_volume_overview',
    description: 'Decentralised exchanges by trading volume, with the 24-hour and 7-day totals for each and for the market as a whole',
    inputSchema: {
      type: 'object',
      properties: { chain: { type: 'string', description: 'Only exchanges on this chain, for example "Ethereum"' }, limit: LIMIT },
    },
    categories: ['read'],
  },
  {
    name: 'dex_protocol_volume',
    description: 'Trading volume for one decentralised exchange: 24-hour, 7-day, 30-day and all-time totals, and the daily series',
    inputSchema: { type: 'object', properties: { protocol: PROTOCOL, points: POINTS }, required: ['protocol'] },
    categories: ['read'],
  },
  {
    name: 'protocol_fees_overview',
    description: 'Protocols by the fees they earn, with 24-hour and 7-day fees and 24-hour revenue for each and for the market as a whole',
    inputSchema: {
      type: 'object',
      properties: { chain: { type: 'string', description: 'Only protocols on this chain, for example "Ethereum"' }, limit: LIMIT },
    },
    categories: ['read'],
  },
  {
    name: 'protocol_fees',
    description: 'Fees and revenue for one protocol: 24-hour, 7-day, 30-day and all-time totals, and the daily series',
    inputSchema: { type: 'object', properties: { protocol: PROTOCOL, points: POINTS }, required: ['protocol'] },
    categories: ['read'],
  },
];
