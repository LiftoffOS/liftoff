import { apifyPrice } from '../sources';
import { deriveSearchQueries, nativeToolCandidates, searchApifyStore, searchConnectorRegistry } from '../sources';
import type { CapabilitySpec } from '../types';

jest.mock('../../connectors/connector-service-client', () => ({
  getCatalog: jest.fn(),
}));
jest.mock('../../connectors/connector-type-registry', () => ({
  fetchRegistry: jest.fn(),
}));
jest.mock('../vendor-gate', () => ({
  switchedOffVendors: jest.fn().mockResolvedValue(new Set()),
}));

import { getCatalog } from '../../connectors/connector-service-client';
import { fetchRegistry } from '../../connectors/connector-type-registry';
import { switchedOffVendors } from '../vendor-gate';

const SPEC: CapabilitySpec = {
  targetSystem: 'instagram',
  operation: 'monitor',
  entity: 'posts',
  mode: 'public_data',
  availableInputs: ['search_terms'],
  requiredOutputFields: ['url'],
  tenantId: 't-1',
  boundConnectorTypes: [],
};

describe('deriveSearchQueries', () => {
  it('builds at most three short queries anchored on the target system', () => {
    const qs = deriveSearchQueries(SPEC);
    expect(qs.length).toBeLessThanOrEqual(3);
    expect(qs[0]).toBe('instagram posts');
  });

  it('always queries a named platform bare, whatever the need is phrased as', () => {
    // The store search is lexical: "reddit forum posts" returns forum
    // scrapers for other sites and the platform's own well-used post
    // scrapers under neither phrasing. The bare name returns them.
    const qs = deriveSearchQueries({
      ...SPEC, targetSystem: 'reddit', operation: 'keyword search recent public posts', entity: 'forum posts',
    });
    expect(qs).toEqual(['reddit forum posts', 'reddit keyword search recent public posts', 'reddit']);
  });

  it('has no bare query when no platform is named', () => {
    const qs = deriveSearchQueries({ ...SPEC, targetSystem: undefined });
    expect(qs).toEqual(['monitor', 'posts monitor']);
  });
});

describe('searchApifyStore', () => {
  const originalFetch = global.fetch;
  afterEach(() => {
    global.fetch = originalFetch;
  });

  it('maps store items to public_data candidates with stable refs', async () => {
    global.fetch = jest.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data: {
          items: [
            {
              name: 'instagram-scraper',
              username: 'apify',
              title: 'Instagram Scraper',
              description: 'scrapes posts',
              stats: { totalUsers30Days: 42052, lastRunStartedAt: '2026-09-08T11:00:00Z' },
            },
          ],
        },
      }),
    }) as unknown as typeof fetch;
    const out = await searchApifyStore(SPEC);
    expect(out[0]).toMatchObject({
      source: 'apify_store',
      sourceRef: 'apify/instagram-scraper',
      mode: 'public_data',
    });
  });

  it('fails to empty on network error', async () => {
    global.fetch = jest.fn().mockRejectedValue(new Error('down')) as unknown as typeof fetch;
    await expect(searchApifyStore(SPEC)).resolves.toEqual([]);
  });

  it('prices every actor from the store\'s own pricing, and never as free', () => {
    // Pay per event, the store's current shape: a one-time start plus a primary per-result event.
    expect(apifyPrice({ pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: {
      'apify-actor-start': { isOneTimeEvent: true, eventPriceUsd: 0.005 },
      'apify-default-dataset-item': { isPrimaryEvent: true, eventPriceUsd: 0.0025 },
      profile: { eventPriceUsd: 0.01 },
    } } })).toEqual({ type: 'PER_RESULT', usd: 0.005 + 0.0025 * 10, estimated: true });
    // The price can sit in the FREE tier of a tiered event.
    expect(apifyPrice({ pricingModel: 'PAY_PER_EVENT', pricingPerEvent: { actorChargeEvents: {
      'apify-default-dataset-item': { isPrimaryEvent: true, eventTieredPricingUsd: { FREE: { tieredEventPriceUsd: 0.01499 } } },
    } } }).usd).toBeCloseTo(0.1499, 9);
    // Price per dataset item, at a typical result count.
    expect(apifyPrice({ pricingModel: 'PRICE_PER_DATASET_ITEM', pricePerUnitUsd: 0.005 })).toEqual({ type: 'PER_RESULT', usd: 0.05, estimated: true });
    // A rental, an unpriced actor, or no pricing at all: compute is still paid for.
    for (const info of [{ pricingModel: 'FLAT_PRICE_PER_MONTH' }, { pricingModel: 'FREE' }, undefined]) {
      expect(apifyPrice(info)).toEqual({ type: 'PER_CALL', usd: 0.03, estimated: true });
    }
  });
});

describe('searchConnectorRegistry', () => {
  it('tags data-vendor connectors public_data and own-account systems own_account', async () => {
    (getCatalog as jest.Mock).mockResolvedValue({
      connectors: [
        { type: 'tikhub', displayName: 'TikHub', description: 'social data', category: 'web_tools' },
        { type: 'slack', displayName: 'Slack', description: 'messaging', category: 'productivity_comms' },
      ],
    });
    (fetchRegistry as jest.Mock).mockResolvedValue(
      new Map([
        ['tikhub', { connectorType: 'tikhub', functionNames: ['fetch_instagram_posts'] }],
        ['slack', { connectorType: 'slack', functionNames: ['send_message'] }],
      ]),
    );
    const out = await searchConnectorRegistry({ ...SPEC, operation: 'send', entity: 'message' });
    const tikhub = out.find((c) => c.connectorType === 'tikhub');
    const slack = out.find((c) => c.connectorType === 'slack');
    expect(tikhub?.mode).toBe('public_data');
    expect(slack?.mode).toBe('own_account');
  });

  it('carries the platform\'s listed price for a platform-funded function, zero for a free source, none for a BYO card', async () => {
    (getCatalog as jest.Mock).mockResolvedValue({
      connectors: [
        { type: 'tikhub', displayName: 'TikHub', description: 'social data', category: 'web_tools' },
        { type: 'nasdaq', displayName: 'Nasdaq', description: 'market data', category: 'data' },
        { type: 'pdl', displayName: 'People Data Labs', description: 'people data', category: 'data' },
      ],
    });
    (fetchRegistry as jest.Mock).mockResolvedValue(
      new Map([
        ['tikhub', { connectorType: 'tikhub', functionNames: ['fetch_instagram_posts'], functionPrices: { fetch_instagram_posts: 0.001 } }],
        ['nasdaq', { connectorType: 'nasdaq', functionNames: ['get_instagram_quote'], functionPrices: { get_instagram_quote: 0 } }],
        ['pdl', { connectorType: 'pdl', functionNames: ['enrich_instagram_person'] }],
      ]),
    );
    const out = await searchConnectorRegistry(SPEC);
    expect(out.find((c) => c.sourceRef === 'tikhub:fetch_instagram_posts')?.price).toEqual({ type: 'PER_CALL', usd: 0.001 });
    expect(out.find((c) => c.sourceRef === 'nasdaq:get_instagram_quote')?.price).toEqual({ type: 'PER_CALL', usd: 0 });
    expect(out.find((c) => c.sourceRef === 'pdl:enrich_instagram_person')?.price).toBeUndefined();
  });

  it('surfaces public_data capabilities ONLY for platform-executable vendors (allowlist), keeps own_account', async () => {
    (getCatalog as jest.Mock).mockResolvedValue({
      connectors: [
        { type: 'tikhub', displayName: 'TikHub', description: 'social data', category: 'web_tools' },        // public_data + platform-executable
        { type: 'scrapingbee', displayName: 'ScrapingBee', description: 'social data', category: 'web_tools' }, // public_data, NO platform executor
        { type: 'slack', displayName: 'Slack', description: 'social data', category: 'productivity_comms' },   // own_account
      ],
    });
    (fetchRegistry as jest.Mock).mockResolvedValue(
      new Map([
        ['tikhub', { connectorType: 'tikhub', functionNames: ['fetch_social_data'] }],
        ['scrapingbee', { connectorType: 'scrapingbee', functionNames: ['scrape_social_data'] }],
        ['slack', { connectorType: 'slack', functionNames: ['read_social_data'] }],
      ]),
    );
    const out = await searchConnectorRegistry({ ...SPEC, targetSystem: '', operation: 'fetch social data', entity: 'data' });
    const types = new Set(out.map((c) => c.connectorType));
    expect(types.has('tikhub')).toBe(true);        // platform-executable public_data → kept
    expect(types.has('scrapingbee')).toBe(false);  // public_data with no platform executor → excluded (the allowlist, not a blacklist)
    expect(types.has('slack')).toBe(true);         // own_account → kept (explicit exception)
  });

  it('does not offer a vendor the operator has switched off', async () => {
    (getCatalog as jest.Mock).mockResolvedValue({
      connectors: [
        { type: 'tikhub', displayName: 'TikHub', description: 'social data', category: 'web_tools' },
        { type: 'strale', displayName: 'Strale', description: 'social data', category: 'web_tools' },
      ],
    });
    (fetchRegistry as jest.Mock).mockResolvedValue(
      new Map([
        ['tikhub', { connectorType: 'tikhub', functionNames: ['fetch_social_data'] }],
        ['strale', { connectorType: 'strale', functionNames: ['check_social_data'] }],
      ]),
    );
    (switchedOffVendors as jest.Mock).mockResolvedValueOnce(new Set(['tikhub']));
    const out = await searchConnectorRegistry({ ...SPEC, targetSystem: '', operation: 'fetch social data', entity: 'data' });
    const types = new Set(out.map((c) => c.connectorType));
    expect(types.has('tikhub')).toBe(false);
    expect(types.has('strale')).toBe(true);
  });

  it('never surfaces a connect/bind-only vendor, even when its category makes it own_account', async () => {
    // saperly's catalog category is social_messaging, so connectorMode returns
    // own_account and the public_data allowlist does not touch it. It is an
    // identity-bound BYO vendor that must stay in the explicit connect/bind flow,
    // so the BYO exclusion must catch it in either mode.
    (getCatalog as jest.Mock).mockResolvedValue({
      connectors: [
        { type: 'saperly', displayName: 'Saperly', description: 'send sms and place calls', category: 'social_messaging' },
        { type: 'slack', displayName: 'Slack', description: 'send messages', category: 'productivity_comms' },
      ],
    });
    (fetchRegistry as jest.Mock).mockResolvedValue(
      new Map([
        ['saperly', { connectorType: 'saperly', functionNames: ['send_sms', 'place_call'] }],
        ['slack', { connectorType: 'slack', functionNames: ['send_message'] }],
      ]),
    );
    const out = await searchConnectorRegistry({ ...SPEC, targetSystem: '', operation: 'send', entity: 'sms message' });
    const types = new Set(out.map((c) => c.connectorType));
    expect(types.has('saperly')).toBe(false); // connect/bind-only → never discovered
    expect(out.some((c) => c.sourceRef?.startsWith('saperly:'))).toBe(false);
    expect(types.has('slack')).toBe(true);     // a genuine own_account system is still surfaced
  });

  it('offers the x402 data vendors as public_data and never the Browserbase rung', async () => {
    // All three sit in catalog category `data`, which connectorMode does not
    // read as public-data on its own. The explicit public-data set is what
    // puts them under the platform-executor allowlist: google_trends and
    // kadec0 execute on the wallet and are offered; browserbase_x402 has no
    // capability executor and must never be a candidate — it is the tenant
    // runtime's last web-fetch rung, not a capability.
    (getCatalog as jest.Mock).mockResolvedValue({
      connectors: [
        { type: 'google_trends', displayName: 'Google Trends', description: 'keyword interest and related queries', category: 'data' },
        { type: 'kadec0', displayName: 'kadec0', description: 'keyword web search and scraping', category: 'data' },
        { type: 'browserbase_x402', displayName: 'Browserbase x402', description: 'keyword web search and page fetch', category: 'data' },
      ],
    });
    (fetchRegistry as jest.Mock).mockResolvedValue(
      new Map([
        ['google_trends', { connectorType: 'google_trends', functionNames: ['get_keyword_trend'] }],
        ['kadec0', { connectorType: 'kadec0', functionNames: ['search_web_serp'] }],
        ['browserbase_x402', { connectorType: 'browserbase_x402', functionNames: ['search_the_web'] }],
      ]),
    );
    const out = await searchConnectorRegistry({ ...SPEC, targetSystem: '', operation: 'search keyword', entity: 'keyword' });
    const byType = new Map(out.map((c) => [c.connectorType, c]));
    expect(byType.get('google_trends')?.mode).toBe('public_data');
    expect(byType.get('kadec0')?.mode).toBe('public_data');
    expect(byType.has('browserbase_x402')).toBe(false);
    expect(out.some((c) => c.sourceRef?.startsWith('browserbase_x402:'))).toBe(false);
  });

  it('offers the aggregator rungs as public_data on a matching need', async () => {
    // locus and vaaya sit in catalog category `data` like the x402 vendors, so
    // only the explicit public-data set makes them candidates at all; without
    // it they read as own-account systems and never enter a public-data pool.
    (getCatalog as jest.Mock).mockResolvedValue({
      connectors: [
        { type: 'locus', displayName: 'Locus', description: 'people and company enrichment, professional email find and verify', category: 'data' },
        { type: 'vaaya', displayName: 'Vaaya', description: 'professional email find and verify, funding and hiring signals, public records', category: 'data' },
      ],
    });
    (fetchRegistry as jest.Mock).mockResolvedValue(
      new Map([
        ['locus', { connectorType: 'locus', functionNames: ['people_search', 'email_find'] }],
        ['vaaya', { connectorType: 'vaaya', functionNames: ['email_find', 'funding_rounds'] }],
      ]),
    );
    const out = await searchConnectorRegistry({ ...SPEC, targetSystem: '', operation: 'find professional email', entity: 'email address' });
    const refs = out.map((c) => c.sourceRef);
    expect(refs).toEqual(expect.arrayContaining(['locus:email_find', 'vaaya:email_find']));
    expect(out.every((c) => c.mode === 'public_data')).toBe(true);
  });

  it('ranks the function whose name matches the target system above off-target ones', async () => {
    (getCatalog as jest.Mock).mockResolvedValue({
      connectors: [{ type: 'tikhub', displayName: 'TikHub', description: 'social data', category: 'web_tools' }],
    });
    (fetchRegistry as jest.Mock).mockResolvedValue(
      new Map([['tikhub', { connectorType: 'tikhub', functionNames: ['bilibili_fetch_user_posts', 'tiktok_fetch_user_posts'] }]]),
    );
    const out = await searchConnectorRegistry({ ...SPEC, targetSystem: 'tiktok', operation: 'get user posts', entity: 'videos' });
    expect(out[0].sourceRef).toBe('tikhub:tiktok_fetch_user_posts');
    expect((out[0].relevance ?? 0)).toBeGreaterThan(out[out.length - 1].relevance ?? 0);
  });

  it('surfaces a Composio-managed connector with no registry functions on its metadata alone', async () => {
    (getCatalog as jest.Mock).mockResolvedValue({
      connectors: [{
        type: 'google_mail', displayName: 'Gmail', description: 'email', category: 'productivity_comms',
        objectsCovered: ['Emails', 'Drafts'], capabilities: [{ capability: 'email_communication' }],
      }],
    });
    (fetchRegistry as jest.Mock).mockResolvedValue(new Map()); // gmail is Composio-managed — not in the native registry
    const out = await searchConnectorRegistry({ ...SPEC, targetSystem: '', operation: 'send an email', entity: 'sent email', mode: 'own_account' });
    const gmail = out.find((c) => c.connectorType === 'google_mail');
    expect(gmail).toBeDefined();
    expect(gmail?.sourceRef).toBe('google_mail'); // connector-level, no :function
    expect(gmail?.mode).toBe('own_account');
  });

  it('keeps a multi-domain rung\'s few candidates PER BUCKET, not per connector', async () => {
    // The defect this exists for: an aggregator card resells several domains
    // behind one connector type (`locus` carries ~295 functions), so a top-N
    // over the CONNECTOR returns N neighbours of whichever domain scored
    // highest and every other domain the card serves becomes unreachable —
    // registered, priced, classified, dispatchable and never a candidate.
    (getCatalog as jest.Mock).mockResolvedValue({
      connectors: [{ type: 'locus', displayName: 'Locus', description: 'resold public data', category: 'data' }],
    });
    (fetchRegistry as jest.Mock).mockResolvedValue(
      new Map([
        ['locus', { connectorType: 'locus', functionNames: [
          // finance: four match, so the cut has to bite somewhere.
          'stock_quote_lookup', 'etf_holdings_lookup', 'commodity_price_lookup', 'currency_rate_lookup',
          // lead generation: three.
          'lead_details_lookup', 'contact_details_lookup', 'prospect_list_lookup',
          // crypto: one.
          'token_balance_lookup',
        ] }],
      ]),
    );
    const out = await searchConnectorRegistry({ ...SPEC, targetSystem: '', entity: 'lookup', operation: 'read' });
    const refs = out.map((c) => c.sourceRef);
    const bucketOf = (ref: string) => out.find((c) => c.sourceRef === ref)?.capabilityBucket;
    // Three per bucket, not three in total.
    expect(refs.filter((r) => bucketOf(r) === 'finance')).toHaveLength(3);
    expect(refs.filter((r) => bucketOf(r) === 'lead_generation')).toHaveLength(3);
    // The one-function bucket is not crowded out by the busy one.
    expect(refs).toContain('locus:token_balance_lookup');
    expect(bucketOf('locus:token_balance_lookup')).toBe('crypto');
    // Every candidate carries the bucket its own name says, never the card's
    // (which is none: no single bucket is true of a multi-domain rung).
    expect(bucketOf('locus:commodity_price_lookup')).toBe('finance');
  });

  it('nudges a candidate whose own function name lands in the need\'s bucket', async () => {
    (getCatalog as jest.Mock).mockResolvedValue({
      connectors: [{ type: 'locus', displayName: 'Locus', description: 'resold public data', category: 'data' }],
    });
    (fetchRegistry as jest.Mock).mockResolvedValue(
      new Map([['locus', { connectorType: 'locus', functionNames: ['commodity_daily_price', 'contact_daily_digest'] }]]),
    );
    const out = await searchConnectorRegistry({ ...SPEC, targetSystem: '', entity: 'daily', operation: 'commodity prices' });
    const commodity = out.find((c) => c.sourceRef === 'locus:commodity_daily_price');
    const contact = out.find((c) => c.sourceRef === 'locus:contact_daily_digest');
    expect(commodity?.capabilityBucket).toBe('finance');
    expect(contact?.capabilityBucket).toBe('lead_generation');
    // Same lexical hit on 'daily'; the on-bucket one ranks above it.
    expect(commodity!.relevance!).toBeGreaterThan(contact!.relevance!);
  });

  it('fails to empty when the registry fetch throws', async () => {
    (getCatalog as jest.Mock).mockRejectedValue(new Error('down'));
    (fetchRegistry as jest.Mock).mockRejectedValue(new Error('down'));
    await expect(searchConnectorRegistry(SPEC)).resolves.toEqual([]);
  });
});

describe('nativeToolCandidates', () => {
  it('offers the platform web tools for public_data specs only', () => {
    expect(nativeToolCandidates(SPEC).map((c) => c.sourceRef)).toContain('web_research');
    expect(nativeToolCandidates({ ...SPEC, mode: 'own_account' })).toEqual([]);
  });
});
