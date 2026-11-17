/**
 * vendor-order — the team's own accounts first, the platform's after; within
 * a tier, fitness for the tool then cost, exactly as the chains ordered them
 * before the re-tier. One case per row of the plan's table and per tier
 * boundary.
 */

import {
  orderFetchChain, orderResearchChain, tierOf, vendorAvailable,
  BROWSER_VENDOR_ORDER, CONNECTOR_TYPE_OF,
} from '../vendor-order';
import type { VendorFlags } from '../global-flags';
import type { WebVendorScope } from '../vendor-scope';
import type { WebToolVendor } from '../web-tool-secrets';

const ALL_ON: VendorFlags = {
  webclaw: true, firecrawl: true, perplexity: true, anchor: true, browserbase: true, tavily: true, exa: true,
  openai: true, google: true, browser_use: true, xai: true, steel: true, browserbase_x402: true, locus_web: true, locus_exa: true,
};
const healthy = { isHealthy: () => true };

function scope(bound: WebToolVendor[]): WebVendorScope {
  return {
    vendors: new Set(bound),
    connectorIds: new Map(bound.map((v) => [v, new Set<string>()])),
    excluded: [],
    basis: bound.length ? 'bound' : 'unbound',
  };
}

describe('tierOf', () => {
  it('a bound connector-backed vendor is bound; a platform-managed one is platform', () => {
    expect(tierOf('exa', scope(['exa']))).toBe('bound');
    expect(tierOf('perplexity', scope(['exa']))).toBe('platform');
  });

  it('a platform-funded vendor is bound only when the team is bound to the workspace connector', () => {
    expect(tierOf('steel', scope(['steel']))).toBe('bound');
    expect(tierOf('steel', scope([]))).toBe('platform');
  });
});

describe('orderFetchChain', () => {
  it('a team bound to nothing: the platform tier in its cost order, nothing else', () => {
    expect(orderFetchChain(false, ALL_ON, scope([]), healthy))
      .toEqual(['perplexity', 'exa', 'locus_exa', 'tavily', 'locus_web', 'steel', 'browser_use', 'browserbase_x402']);
  });

  it('a team bound to Exa reads a page through Exa before the platform tier, and the platform Exa slot is then not repeated', () => {
    expect(orderFetchChain(false, ALL_ON, scope(['exa']), healthy))
      .toEqual(['exa', 'perplexity', 'locus_exa', 'tavily', 'locus_web', 'steel', 'browser_use', 'browserbase_x402']);
  });

  it('the Exa overflow stands directly behind the platform Exa in both the fetch and research tiers', () => {
    const fetch = orderFetchChain(false, ALL_ON, scope([]), healthy);
    expect(fetch.indexOf('locus_exa')).toBe(fetch.indexOf('exa') + 1);
    const research = orderResearchChain(ALL_ON, scope([]), healthy);
    expect(research.indexOf('locus_exa')).toBe(research.indexOf('exa') + 1);
  });

  it('no JS: bound text vendors by cost, then bound browsers by preference, then the platform tier', () => {
    const bound: WebToolVendor[] = ['webclaw', 'exa', 'browser_use', 'anchor_browser', 'tavily', 'steel', 'firecrawl', 'browserbase'];
    expect(orderFetchChain(false, ALL_ON, scope(bound), healthy)).toEqual([
      'exa', 'tavily', 'firecrawl', 'webclaw',
      'anchor', 'browserbase', 'steel', 'browser_use',
      'perplexity', 'locus_exa', 'locus_web', 'browserbase_x402',
    ]);
  });

  it('JS needed: bound browsers lead, bound text vendors are the Hail Mary, then the platform tier in the same shape', () => {
    const bound: WebToolVendor[] = ['exa', 'tavily', 'anchor_browser', 'browserbase'];
    expect(orderFetchChain(true, ALL_ON, scope(bound), healthy)).toEqual([
      'anchor', 'browserbase', 'exa', 'tavily',
      'locus_web', 'steel', 'browser_use', 'perplexity', 'locus_exa', 'browserbase_x402',
    ]);
  });

  it('JS needed, a team bound to nothing: a rendering read is reachable within the two-attempt budget', () => {
    const chain = orderFetchChain(true, ALL_ON, scope([]), healthy);
    expect(chain).toEqual(['locus_web', 'steel', 'browser_use', 'perplexity', 'exa', 'locus_exa', 'tavily', 'browserbase_x402']);
    expect(chain.slice(0, 2)).toEqual(['locus_web', 'steel']);
  });

  it('a bound Steel is tried as the team\'s own account, and the platform Steel slot is then not repeated', () => {
    expect(orderFetchChain(false, ALL_ON, scope(['steel']), healthy))
      .toEqual(['steel', 'perplexity', 'exa', 'locus_exa', 'tavily', 'locus_web', 'browser_use', 'browserbase_x402']);
  });

  it('a workspace connector the team is not bound to never appears in the bound tier', () => {
    // vendor-scope already left it out of `vendors`; the order only sees the
    // scope. A vendor the platform also funds (Exa) still serves, from the
    // platform tier behind Perplexity; one it does not (Firecrawl) is absent.
    const chain = orderFetchChain(false, ALL_ON, scope([]), healthy);
    expect(chain.indexOf('exa')).toBeGreaterThan(chain.indexOf('perplexity'));
    expect(chain).not.toContain('firecrawl');
    expect(chain).not.toContain('webclaw');
  });

  it('the kill-switch and vendor health still filter both tiers', () => {
    const flags = { ...ALL_ON, exa: false, perplexity: false, locus_web: false, locus_exa: false };
    const health = { isHealthy: (v: string) => v !== 'steel' };
    expect(orderFetchChain(false, flags, scope(['exa', 'tavily']), health))
      .toEqual(['tavily', 'browser_use', 'browserbase_x402']);
  });
});

describe('orderResearchChain', () => {
  it('a team bound to nothing researches through Perplexity, then the platform\'s pay-as-you-go Exa and Tavily', () => {
    expect(orderResearchChain(ALL_ON, scope([]), healthy)).toEqual(['perplexity', 'exa', 'locus_exa', 'tavily']);
  });

  it('bound text vendors by research cost, then Perplexity and the platform\'s Exa overflow as the safety net', () => {
    expect(orderResearchChain(ALL_ON, scope(['firecrawl', 'tavily', 'exa', 'webclaw']), healthy))
      .toEqual(['exa', 'tavily', 'webclaw', 'firecrawl', 'perplexity', 'locus_exa']);
  });

  it('with Perplexity switched off, the team\'s own accounts lead and the platform\'s keys remain the net', () => {
    expect(orderResearchChain({ ...ALL_ON, perplexity: false }, scope(['exa']), healthy)).toEqual(['exa', 'locus_exa', 'tavily']);
    expect(orderResearchChain({ ...ALL_ON, perplexity: false }, scope([]), healthy)).toEqual(['exa', 'locus_exa', 'tavily']);
    expect(orderResearchChain({ ...ALL_ON, perplexity: false, exa: false, tavily: false, locus_exa: false }, scope([]), healthy)).toEqual([]);
  });
});

describe('the shared tables', () => {
  it('the browser order pairs every browser with its connector, so the session picker and the fetch chain agree', () => {
    for (const v of BROWSER_VENDOR_ORDER) expect(CONNECTOR_TYPE_OF[v]).not.toBeNull();
    expect([...BROWSER_VENDOR_ORDER]).toEqual(['anchor', 'browserbase', 'steel', 'browser_use']);
  });

  it('vendorAvailable admits a platform-managed vendor without a binding, a platform-funded one too, and a connector-only one with its binding', () => {
    expect(vendorAvailable('perplexity', ALL_ON, new Set())).toBe(true);
    expect(vendorAvailable('locus_web', ALL_ON, new Set())).toBe(true);
    expect(vendorAvailable('exa', ALL_ON, new Set())).toBe(true);
    expect(vendorAvailable('exa', ALL_ON, new Set(['exa']))).toBe(true);
    expect(vendorAvailable('firecrawl', ALL_ON, new Set())).toBe(false);
    expect(vendorAvailable('firecrawl', ALL_ON, new Set(['firecrawl']))).toBe(true);
    expect(vendorAvailable('steel', ALL_ON, new Set())).toBe(true);
  });
});
