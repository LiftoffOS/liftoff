// The data source rates' assembly: sources grouped by end brand, each call
// priced as the next call at the workspace's current band through the booking
// path's own OU functions, and nothing of the source's plumbing in the output.

jest.mock('../../infrastructure/logging', () => ({
  log: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const fetchRegistry = jest.fn();
jest.mock('../../connectors/connector-type-registry', () => ({
  fetchRegistry: (...a: unknown[]) => fetchRegistry(...a),
}));

const switchedOffVendors = jest.fn();
jest.mock('../../capability-discovery/vendor-gate', () => ({
  switchedOffVendors: (...a: unknown[]) => switchedOffVendors(...a),
}));

// The real set's shape: platform-funded internal vendors. crunchbase is
// BYO-only and must never be listed.
jest.mock('../../capability-discovery/vendor-execution', () => ({
  PLATFORM_EXECUTABLE_VENDORS: new Set(['tikhub', 'locus', 'strale', 'defillama', 'kadec0', 'gloria']),
}));

const resolveAccountIdForTenant = jest.fn();
jest.mock('../../cost-attribution/repository', () => ({
  resolveAccountIdForTenant: (...a: unknown[]) => resolveAccountIdForTenant(...a),
}));

const clientQuery = jest.fn();
const release = jest.fn();
jest.mock('../../infrastructure/database', () => ({
  getPool: () => ({ connect: async () => ({ query: clientQuery, release }) }),
}));

import type { ConnectorTypeMeta } from '../../connectors/connector-type-registry';
import { _resetOuDefinitionRateCacheForTesting } from '../../cost-attribution/ou-bucket-service';
import { VENDOR_BRAND_TOKENS } from '../../liftoff/capability-tools';
import { getDataSources, INTERMEDIARY_TOKENS, quoteOus } from '../service';

const TENANT = '11111111-1111-4111-8111-111111111111';
const ACCOUNT = '33333333-3333-4333-8333-333333333333';

const REGISTRY: ConnectorTypeMeta[] = [
  {
    connectorType: 'tikhub',
    category: 'social',
    functionNames: ['tikhub_user_profile', 'tikhub_video_comments', 'tikhub_raw_endpoint'],
    functionPrices: { tikhub_user_profile: 0.014, tikhub_video_comments: 0, tikhub_raw_endpoint: 0.02 },
    functionBrands: {
      tikhub_user_profile: { brand: 'TikTok', category: 'Social Media', label: 'Creator profile' },
      tikhub_video_comments: { brand: 'TikTok', category: 'Social Media', label: 'Video comments' },
      // tikhub_raw_endpoint has no brand entry: not listed.
    },
  },
  {
    connectorType: 'locus',
    category: 'data',
    functionNames: ['locus_sec_filing'],
    functionPrices: { locus_sec_filing: 0.0028 },
    functionBrands: { locus_sec_filing: { brand: 'SEC EDGAR', category: 'Public Records', label: 'Company filing' } },
  },
  {
    // A free source.
    connectorType: 'defillama',
    category: 'data',
    functionNames: ['get_protocol_tvl'],
    functionPrices: { get_protocol_tvl: 0 },
    functionBrands: { get_protocol_tvl: { brand: 'CoinDesk Data', category: 'Crypto', label: 'Protocol TVL' } },
  },
  {
    // Switched off by an operator.
    connectorType: 'strale',
    category: 'data',
    functionNames: ['strale_launch_lookup'],
    functionPrices: { strale_launch_lookup: 0.01 },
    functionBrands: { strale_launch_lookup: { brand: 'Product Hunt', category: 'Startups', label: 'Launch lookup' } },
  },
  {
    // BYO-only: not a platform-executable vendor.
    connectorType: 'crunchbase',
    category: 'data',
    functionNames: ['cb_org'],
    functionPrices: { cb_org: 0.05 },
    functionBrands: { cb_org: { brand: 'Dealroom', category: 'Startups', label: 'Organization' } },
  },
  {
    // A brand entry that names an intermediary is dropped, not shown.
    connectorType: 'gloria',
    category: 'news',
    functionNames: ['gloria_headlines'],
    functionPrices: { gloria_headlines: 0.001 },
    functionBrands: { gloria_headlines: { brand: 'Gloria News', category: 'News', label: 'Headlines' } },
  },
  {
    // Web search: priced and branded, but not listed as a rate.
    connectorType: 'kadec0',
    category: 'web',
    functionNames: ['kadec0_web_search'],
    functionPrices: { kadec0_web_search: 0.005 },
    functionBrands: { kadec0_web_search: { brand: 'The Open Web', category: 'The Open Web', label: 'Web search' } },
  },
];

interface Ladder { consumed: number; included: number; includedRate: number; precommitRate: number; reloadRate: number }

function givenWorkspace(ladder: Ladder | null, premium: number | null = 1.10) {
  resolveAccountIdForTenant.mockResolvedValue(ladder ? ACCOUNT : null);
  clientQuery.mockImplementation(async (sql: string) => {
    if (sql.includes('pass_through_premium')) return { rows: premium === null ? [] : [{ value: String(premium) }] };
    if (sql.includes('ou_definition_rate_usd')) return { rows: [{ value: '0.01' }] };
    if (sql.includes('FROM billing_controls')) {
      if (!ladder) return { rows: [] };
      return {
        rows: [{
          plan_included_ous: String(ladder.included),
          precommit_extra_ous: '0',
          referral_bonus_ous: '0',
          included_rate_usd_per_ou: String(ladder.includedRate),
          precommit_rate_usd_per_ou: String(ladder.precommitRate),
          reload_rate_usd_per_ou: String(ladder.reloadRate),
          ous_consumed_this_period: String(ladder.consumed),
        }],
      };
    }
    throw new Error(`unexpected query: ${sql}`);
  });
}

const INCLUDED: Ladder = { consumed: 100, included: 10_000, includedRate: 0.028, precommitRate: 0.028, reloadRate: 0.03125 };
const IN_RELOAD: Ladder = { ...INCLUDED, consumed: 20_000 };
const EXEMPT: Ladder = { consumed: 100, included: 10_000, includedRate: 0, precommitRate: 0, reloadRate: 0 };

beforeEach(() => {
  jest.clearAllMocks();
  _resetOuDefinitionRateCacheForTesting();
  fetchRegistry.mockResolvedValue(new Map(REGISTRY.map((t) => [t.connectorType, t])));
  switchedOffVendors.mockResolvedValue(new Set(['strale']));
});

const callOf = (res: Awaited<ReturnType<typeof getDataSources>>, brand: string, label: string) =>
  res.sources.find((s) => s.brand === brand)?.calls.find((c) => c.label === label);

describe('getDataSources', () => {
  it('groups calls by end brand, sorted by category then brand, calls by OU descending', async () => {
    givenWorkspace(INCLUDED);
    const res = await getDataSources(TENANT);

    expect(res.sources.map((s) => [s.category, s.brand])).toEqual([
      ['Crypto', 'CoinDesk Data'],
      ['Public Records', 'SEC EDGAR'],
      ['Social Media', 'TikTok'],
    ]);
    expect(res.sources.find((s) => s.brand === 'TikTok')).toEqual({
      brand: 'TikTok',
      category: 'Social Media',
      calls: [
        { label: 'Creator profile', ou: 0.55 },
        { label: 'Video comments', ou: 0 },
      ],
    });
    expect(release).toHaveBeenCalledTimes(1);
  });

  it('prices a call at the included rate: supplier USD x premium / 0.028', async () => {
    givenWorkspace(INCLUDED);
    const res = await getDataSources(TENANT);
    // 0.014 * 1.10 / 0.028 = 0.55
    expect(callOf(res, 'TikTok', 'Creator profile')?.ou).toBe(0.55);
    // 0.0028 * 1.10 / 0.028 = 0.11
    expect(callOf(res, 'SEC EDGAR', 'Company filing')?.ou).toBe(0.11);
  });

  it('prices the next call at the reload rate once consumption is past the bands', async () => {
    givenWorkspace(IN_RELOAD);
    const res = await getDataSources(TENANT);
    // 0.014 * 1.10 / 0.03125 = 0.4928
    expect(callOf(res, 'TikTok', 'Creator profile')?.ou).toBe(0.49);
  });

  it('prices an exempt workspace (a rate of 0) on the definition path, like the booking path', async () => {
    givenWorkspace(EXEMPT);
    const res = await getDataSources(TENANT);
    // ousWorth has no answer over a free band: 0.014 / 0.01 = 1.4
    expect(callOf(res, 'TikTok', 'Creator profile')?.ou).toBe(1.4);
  });

  it('a free source yields 0', async () => {
    givenWorkspace(INCLUDED);
    const res = await getDataSources(TENANT);
    expect(callOf(res, 'CoinDesk Data', 'Protocol TVL')?.ou).toBe(0);
    expect(quoteOus(0, { premium: 1.1, ladder: null, definitionRateUsd: 0.01 })).toBe(0);
  });

  it('omits switched-off vendors, non-platform vendors, unbranded functions and intermediary-named brands', async () => {
    givenWorkspace(INCLUDED);
    const res = await getDataSources(TENANT);
    const brands = res.sources.map((s) => s.brand);
    expect(brands).not.toContain('Product Hunt');   // strale is switched off
    expect(brands).not.toContain('Dealroom');       // crunchbase is BYO-only
    expect(brands).not.toContain('Gloria News');    // names an intermediary
    const tiktokLabels = res.sources.find((s) => s.brand === 'TikTok')!.calls.map((c) => c.label);
    expect(tiktokLabels).toHaveLength(2);           // tikhub_raw_endpoint has no brand
  });

  it('does not list The Open Web as a rate, though its calls are priced and branded', async () => {
    givenWorkspace(INCLUDED);
    const res = await getDataSources(TENANT);
    expect(res.sources.map((s) => s.brand)).not.toContain('The Open Web');
    expect(res.sources.map((s) => s.category)).not.toContain('The Open Web');
  });

  it('the serialized response names no intermediary, connector type or function', async () => {
    givenWorkspace(INCLUDED);
    const body = JSON.stringify(await getDataSources(TENANT)).toLowerCase();
    const plumbing = REGISTRY.flatMap((t) => [t.connectorType, ...t.functionNames]);
    const tokens = [...VENDOR_BRAND_TOKENS, ...INTERMEDIARY_TOKENS, ...plumbing];
    const found = tokens.filter((t) =>
      new RegExp(`\\b${t.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`).test(body));
    expect(found).toEqual([]);
  });

  it('prices on the definition path when the workspace has no billing controls', async () => {
    givenWorkspace(null);
    const res = await getDataSources(TENANT);
    expect(callOf(res, 'TikTok', 'Creator profile')?.ou).toBe(1.4);
  });
});
