// Data Sources: what one call to each data source costs THIS workspace, in
// Operating Units, listed by the brand a person knows the data by.
//
// Three inputs, none of them computed here:
//   - prices and brands: connector-service's connector-type registry
//     (`functionPrices` is the supplier's USD per call, `functionBrands` the
//     end brand, category and call label). A function with no brand entry, or
//     no price, is not listed: a price that cannot be quoted honestly is left
//     off rather than shown as free.
//   - which vendors: the platform-funded set the executor runs, less the ones
//     an operator has switched off.
//   - the OU pricing: the booking path's own functions in
//     cost-attribution/ou-bucket-service.ts (the premium, the ladder, ousWorth),
//     so the rate a person reads is the rate a call is booked at.
//
// The response carries a brand, a category and a label and nothing else of
// the source: no connector type, vendor slug or function name.

import { getPool } from '../infrastructure/database';
import { log } from '../infrastructure/logging';
import { fetchRegistry, type ConnectorTypeMeta } from '../connectors/connector-type-registry';
import { PLATFORM_EXECUTABLE_VENDORS } from '../capability-discovery/vendor-execution';
import { switchedOffVendors } from '../capability-discovery/vendor-gate';
import { resolveAccountIdForTenant } from '../cost-attribution/repository';
import {
  getOuDefinitionRateUsd,
  getPassThroughPremium,
  ousWorth,
  rateLadderFrom,
  RATE_LADDER_COLUMNS,
  type RateLadder,
  type RateLadderRow,
} from '../cost-attribution/ou-bucket-service';

export interface DataSourceCall {
  label: string;
  ou: number;
}

export interface DataSource {
  brand: string;
  category: string;
  calls: DataSourceCall[];
}

export interface DataSourcesResponse {
  sources: DataSource[];
}

/** Names of the intermediaries between the platform and an end brand:
 *  resellers, aggregators, payment rails and fetch vendors. None of them may
 *  reach a person, so a registry entry whose brand, category or label names
 *  one is dropped (and logged) rather than shown. */
export const INTERMEDIARY_TOKENS = [
  'locus', 'vaaya', 'strale', 'tikhub', 'apify', 'kadec0', 'x402', 'browserbase',
  'gloria', 'firecrawl', 'exa', 'signalbase', 'tomba', 'blockrun', 'dataforseo', 'kronossignals', 'kronos',
];

const INTERMEDIARY_RE = new RegExp(
  `\\b(${INTERMEDIARY_TOKENS.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})\\b`,
  'i',
);

/** Brands not listed as a rate. The Open Web is web search and
 *  page reads of whatever site an agent opens (and Store-actor runs, which
 *  are not in the registry at all): there is no source to name, only the
 *  service that fetches. This only keeps them off the rate list. Their calls
 *  are booked and attributed exactly like any other, so they still count in
 *  Insights and the dashboard's usage, which read cost_attribution_events. */
export const UNLISTED_BRANDS: ReadonlySet<string> = new Set(['The Open Web']);

/** What the OU quote for one supplier charge is computed from. */
export interface OuPricing {
  /** `pass_through_premium`, or null when the setting is absent. */
  premium: number | null;
  /** The workspace's bands and consumption; null when it has no
   *  billing_controls row. */
  ladder: RateLadder | null;
  /** `ou_definition_rate_usd`, USD per OU. */
  definitionRateUsd: number;
}

/** The OUs one call charging the platform `usd` costs this workspace, priced
 *  as the NEXT call at its current band. Mirrors applyOuConsumption's
 *  pass-through branch: supplier USD times the premium, converted at the
 *  workspace's own rates by ousWorth; and where that has no answer (no
 *  premium set, an exempt workspace or a free band, no ladder at all) the
 *  definition path, supplier USD over the OU definition. Zero USD is zero. */
export function quoteOus(usd: number, pricing: OuPricing): number {
  if (!(usd > 0)) return 0;
  const passThrough = pricing.premium === null || pricing.ladder === null
    ? null
    : ousWorth(usd * pricing.premium, pricing.ladder);
  return passThrough ?? usd / pricing.definitionRateUsd;
}

const round2 = (n: number): number => Math.round(n * 100) / 100;

/** The workspace's pricing inputs, read per request. */
export async function readOuPricing(tenantId: string): Promise<OuPricing> {
  const accountId = await resolveAccountIdForTenant(tenantId);
  const client = await getPool().connect();
  try {
    const premium = await getPassThroughPremium(client);
    const definitionRateUsd = await getOuDefinitionRateUsd(client);
    let ladder: RateLadder | null = null;
    if (accountId) {
      // billing_controls is account-keyed and not RLS; the same read the
      // booking path makes, without its FOR UPDATE: this is a quote.
      const { rows } = await client.query<RateLadderRow>(
        `SELECT ${RATE_LADDER_COLUMNS} FROM billing_controls WHERE account_id = $1`,
        [accountId],
      );
      if (rows[0]) ladder = rateLadderFrom(rows[0]);
    }
    return { premium, ladder, definitionRateUsd };
  } finally {
    client.release();
  }
}

type BrandEntry = { brand: string; category: string; label: string };

function isBrandEntry(v: unknown): v is BrandEntry {
  const e = v as Partial<BrandEntry> | null;
  return !!e && typeof e.brand === 'string' && e.brand.trim() !== ''
    && typeof e.category === 'string' && e.category.trim() !== ''
    && typeof e.label === 'string' && e.label.trim() !== '';
}

/** The sources from the registry, the vendors it may list, and a quote
 *  function. Pure, so the whole grouping is testable without the network. */
export function assembleDataSources(
  registry: Map<string, ConnectorTypeMeta>,
  vendors: ReadonlySet<string>,
  switchedOff: ReadonlySet<string>,
  quote: (usd: number) => number,
): DataSourcesResponse {
  const byBrand = new Map<string, { source: DataSource; calls: Map<string, DataSourceCall> }>();
  const sourceFor = (brand: string, category: string) => {
    let entry = byBrand.get(brand);
    if (!entry) {
      entry = { source: { brand, category, calls: [] }, calls: new Map() };
      byBrand.set(brand, entry);
    }
    return entry;
  };

  for (const [connectorType, meta] of registry) {
    if (!vendors.has(connectorType) || switchedOff.has(connectorType)) continue;
    const brands = meta.functionBrands ?? {};
    const prices = meta.functionPrices ?? {};
    for (const fn of meta.functionNames ?? []) {
      const b = brands[fn];
      const usd = prices[fn];
      if (!isBrandEntry(b) || typeof usd !== 'number' || !Number.isFinite(usd)) continue;
      if (UNLISTED_BRANDS.has(b.brand.trim())) continue;
      if (INTERMEDIARY_RE.test(b.brand) || INTERMEDIARY_RE.test(b.category) || INTERMEDIARY_RE.test(b.label)) {
        log.warn({ connectorType, functionName: fn }, 'data-sources: brand entry names an intermediary; not listed');
        continue;
      }
      const entry = sourceFor(b.brand.trim(), b.category.trim());
      const label = b.label.trim();
      const ou = round2(quote(usd));
      // Two suppliers of the same call: show the higher, so a rate never
      // quotes below what a call can be booked at.
      const prior = entry.calls.get(label);
      if (!prior || ou > prior.ou) entry.calls.set(label, { label, ou });
    }
  }

  const sources = [...byBrand.values()]
    .filter((e) => e.calls.size > 0)
    .map(({ source, calls }) => ({
      ...source,
      calls: [...calls.values()].sort((a, b) => b.ou - a.ou || a.label.localeCompare(b.label)),
    }));
  sources.sort((a, b) => a.category.localeCompare(b.category) || a.brand.localeCompare(b.brand));
  return { sources };
}

/** The rates for one workspace, for Insights Manager's get_data_source_rates. The registry read is the
 *  registry's own 60 s cache; the switched-off set is the vendor gate's cache;
 *  the pricing inputs are read on every request. */
export async function getDataSources(tenantId: string): Promise<DataSourcesResponse> {
  const [registry, switchedOff, pricing] = await Promise.all([
    fetchRegistry(),
    switchedOffVendors(),
    readOuPricing(tenantId),
  ]);
  return assembleDataSources(registry, PLATFORM_EXECUTABLE_VENDORS, switchedOff, (usd) => quoteOus(usd, pricing));
}
