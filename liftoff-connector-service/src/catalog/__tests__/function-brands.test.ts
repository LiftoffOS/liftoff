// FITNESS FUNCTION — every priced data function says whose data it is, and
// none of them names the reseller.
//
// The dashboard's Data Sources page lists sources by end brand from this map. A function
// that is priced but unmapped would be charged for and never shown, so every
// priced function of a covered type is either mapped or deliberately
// EXCLUDED; a newly priced function fails here until someone decides.

import {
  BRANDED_CONNECTOR_TYPES,
  EXCLUDED,
  FORBIDDEN_WORDS,
  LOCUS_PARSE_PROVIDER_BRANDS,
  getFunctionBrands,
  getFunctionBrandsFor,
} from '../function-brands.js';
import { getFunctionPrices } from '../function-prices.js';
import { LOCUS_PARSE_ALLOWLIST } from '../locus-parse-allowlist.js';
import { VAAYA_DISPATCH } from '../generated/vaaya.js';

const forbidden = new RegExp(`\\b(${FORBIDDEN_WORDS.join('|')})\\b`, 'i');

function excluded(connectorType: string, fn: string): boolean {
  const list = EXCLUDED[connectorType];
  return list === 'all' || (list?.includes(fn) ?? false);
}

describe('function brands', () => {
  const brands = getFunctionBrands();

  it.each([...BRANDED_CONNECTOR_TYPES, 'browserbase_x402'])(
    'maps or explicitly excludes every priced %s function',
    (connectorType) => {
      const priced = Object.keys(getFunctionPrices(connectorType) ?? {});
      expect(priced.length).toBeGreaterThan(0);
      const unaccounted = priced.filter((fn) => !brands[connectorType]?.[fn] && !excluded(connectorType, fn));
      expect(unaccounted).toEqual([]);
    },
  );

  it('never both maps and excludes a function, and excludes only priced ones', () => {
    for (const [connectorType, list] of Object.entries(EXCLUDED)) {
      if (list === 'all') {
        expect(getFunctionBrandsFor(connectorType)).toBeUndefined();
        continue;
      }
      const priced = getFunctionPrices(connectorType) ?? {};
      for (const fn of list) {
        expect(brands[connectorType]?.[fn]).toBeUndefined();
        // A stale exclusion hides nothing and would mask a rename.
        expect(fn in priced).toBe(true);
      }
    }
  });

  it('maps only priced functions', () => {
    for (const [connectorType, map] of Object.entries(brands)) {
      const priced = getFunctionPrices(connectorType) ?? {};
      expect(Object.keys(map).filter((fn) => !(fn in priced))).toEqual([]);
    }
  });

  it('never names an intermediary in a brand or a label', () => {
    const offenders: string[] = [];
    for (const [connectorType, map] of Object.entries(brands)) {
      for (const [fn, b] of Object.entries(map)) {
        if (forbidden.test(b.brand) || forbidden.test(b.label)) offenders.push(`${connectorType}.${fn}: ${b.brand} / ${b.label}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  // Calls of one brand that read the same are one call type to the customer;
  // platform-backend lists them once, at the higher rate. So a label never
  // carries a supplier API version or a made-up tiebreaker.
  it('writes labels as plain product copy: non-empty, no em dash, no API version or tiebreaker', () => {
    for (const map of Object.values(brands)) {
      for (const b of Object.values(map)) {
        expect(b.brand.trim()).not.toBe('');
        expect(b.label.trim()).not.toBe('');
        expect(b.label).not.toContain('—');
        expect(b.label).not.toMatch(/\$|per call/i);
        expect(b.label).not.toMatch(/\bV\d+\b|\(option \d+\)|_/);
      }
    }
  });

  it('files each brand under one category', () => {
    const categories = new Map<string, Set<string>>();
    for (const map of Object.values(brands)) {
      for (const b of Object.values(map)) {
        const set = categories.get(b.brand) ?? new Set<string>();
        set.add(b.category);
        categories.set(b.brand, set);
      }
    }
    const split = [...categories].filter(([, set]) => set.size > 1).map(([brand]) => brand);
    expect(split).toEqual([]);
  });

  it('names every resold public-data provider, and only the allowlisted ones', () => {
    expect(Object.keys(LOCUS_PARSE_PROVIDER_BRANDS).sort()).toEqual(LOCUS_PARSE_ALLOWLIST.map((p) => p.provider).sort());
  });

  it('brands the worked examples', () => {
    expect(brands.locus.home_listings_search_homes_for_sale).toEqual({
      brand: 'Zillow',
      category: 'Real Estate',
      label: 'Search homes for sale',
    });
    expect(brands.locus.email_verify.brand).toBe('Hunter');
    expect(brands.locus.web_semantic_search.brand).toBe('The Open Web');
    expect(brands.locus.insider_trading_get_insider_buys.brand).toBe('SEC Form 4');
    expect(brands.tikhub.tiktok_web_fetch_user_post).toEqual({ brand: 'TikTok', category: 'Social Media', label: 'User posts' });
    expect(brands.tikhub.twitter_web_fetch_user_profile.brand).toBe('X');
    expect(brands.strale.au_company_data).toEqual({
      brand: 'Company Registries',
      category: 'Company Registries',
      label: 'Australian company data (ABR)',
    });
    expect(brands.strale.code_review).toBeUndefined();
    expect(brands.nasdaq.get_stock_quote.brand).toBe('Nasdaq');
    expect(brands.gloria.get_enriched_news.brand).toBe('Crypto News');
  });

  it('brands every edgar/ action SEC EDGAR, and names no reseller for tomba/ or signalbase/', () => {
    for (const [fn, entry] of Object.entries(VAAYA_DISPATCH)) {
      const b = brands.vaaya[fn];
      if (entry.action.startsWith('edgar/')) expect(b).toMatchObject({ brand: 'SEC EDGAR', category: 'Public Records' });
      if (entry.action.startsWith('tomba/')) expect(b.brand).toBe('Email Finder');
      if (entry.action.startsWith('signalbase/')) expect(b.brand).toBe('Company Signals');
    }
  });
});
