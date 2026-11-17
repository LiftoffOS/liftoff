import { classifyConnectorToBucket, bucketById, functionBucket, inferQueryBucket } from '../capability-tree';

describe('classifyConnectorToBucket', () => {
  it('maps the absorbed vendors to their curated bucket', () => {
    expect(classifyConnectorToBucket('tikhub')).toBe('social_media');
    expect(classifyConnectorToBucket('nasdaq')).toBe('finance');
    expect(classifyConnectorToBucket('gloria')).toBe('crypto');
    expect(classifyConnectorToBucket('strale')).toBe('compliance');
    expect(classifyConnectorToBucket('apify')).toBe('web_scraping');
    expect(classifyConnectorToBucket('hunterio')).toBe('lead_generation');
  });

  it('is case-insensitive on the connector type', () => {
    expect(classifyConnectorToBucket('TikHub')).toBe('social_media');
  });

  it('falls back to the catalog category when the type is unmapped', () => {
    expect(classifyConnectorToBucket('some_new_vendor', 'news')).toBe('news');
    expect(classifyConnectorToBucket('some_new_vendor', 'ecommerce')).toBe('ecommerce');
  });

  it('returns null when nothing maps (candidate still ranks, just unlabeled)', () => {
    expect(classifyConnectorToBucket('some_new_vendor')).toBeNull();
    expect(classifyConnectorToBucket('some_new_vendor', 'unknown_category')).toBeNull();
  });
});

describe('bucketById', () => {
  it('resolves the vendors to a defined, vendor-agnostic bucket label', () => {
    for (const t of ['tikhub', 'nasdaq', 'gloria', 'strale', 'apify']) {
      const bucket = bucketById(classifyConnectorToBucket(t));
      expect(bucket).toBeDefined();
      expect(bucket?.displayName.toLowerCase()).not.toContain(t);
    }
  });

  it('returns undefined for a null/unknown id', () => {
    expect(bucketById(null)).toBeUndefined();
    expect(bucketById('no_such_bucket')).toBeUndefined();
  });
});

describe('inferQueryBucket', () => {
  it('routes an unambiguous need to the matching bucket', () => {
    expect(inferQueryBucket('tiktok posts')).toBe('social_media');
    expect(inferQueryBucket('stock quote for a ticker')).toBe('finance');
    expect(inferQueryBucket('sanctions screening')).toBe('compliance');
    expect(inferQueryBucket('scrape a web page')).toBe('web_scraping');
  });

  it('returns null when no cue matches, so the need ranks on relevance alone', () => {
    expect(inferQueryBucket('xyzzy plugh frobnicate')).toBeNull();
  });

  it('routes to the bucket with the most cue hits, and its bucket matches the on-target vendor', () => {
    // The whole point of the boost: the query bucket equals the vendor's bucket
    // so the on-target candidate is nudged up.
    expect(inferQueryBucket('tiktok posts')).toBe(classifyConnectorToBucket('tikhub'));
    expect(inferQueryBucket('stock quote')).toBe(classifyConnectorToBucket('nasdaq'));
  });
});

describe('functionBucket', () => {
  it('classifies a multi-domain rung per function, which is the only classification true of each call', () => {
    // `locus` resells all of these behind ONE connector type, so the card
    // itself has no bucket (classifyConnectorToBucket returns null for it) and
    // the function name is the only thing that says what the call is.
    expect(classifyConnectorToBucket('locus', 'data')).toBeNull();
    expect(functionBucket('commodity_daily_price')).toBe('finance');
    expect(functionBucket('currency_daily_exchange_rate')).toBe('finance');
    expect(functionBucket('people_search')).toBe('lead_generation');
    expect(functionBucket('keyword_search_volume')).toBe('search_seo');
    expect(functionBucket('wallet_token_balances')).toBe('crypto');
    expect(functionBucket('web_page_scrape')).toBe('web_scraping');
    expect(functionBucket('vehicle_history_get_value')).toBe('automotive');
  });

  it('reads a domain-first name subject-first, so a qualifier does not take the bucket', () => {
    // These names are written subject first, the generated ones prefixed by
    // their capability word. 'prices' is longer than 'fuel', so cue length
    // alone files every fuel-price read under ecommerce — found on a live
    // discovery probe, which is the only place a wrong label shows.
    expect(functionBucket('fuel_prices_get_state_gas_prices')).toBe('automotive');
    expect(functionBucket('fuel_prices_get_ev_charging_prices')).toBe('automotive');
    expect(functionBucket('salvage_auctions_search_listings')).toBe('automotive');
    expect(functionBucket('crypto_search')).toBe('crypto');
    expect(functionBucket('token_price_history')).toBe('crypto');
  });

  it('breaks a tie on the more specific cue, not on which bucket is declared first', () => {
    // 'price' is an ecommerce cue and ecommerce is declared before finance, so
    // hit-count alone files every commodity and FX price under ecommerce.
    expect(functionBucket('commodity_daily_price')).toBe('finance');
    expect(functionBucket('crypto_daily_close_price')).toBe('crypto');
    // 'people search' (13) beats 'search' (6).
    expect(functionBucket('people_search')).toBe('lead_generation');
  });

  it('matches whole words only, so a cue inside another word is not a hit', () => {
    // 'fund' and 'fx' are finance cues; neither word appears here.
    expect(functionBucket('refunded_orders')).not.toBe('finance');
    // No cue at all: the caller falls back to the connector's bucket.
    expect(functionBucket('email_verify')).toBeNull();
    expect(functionBucket('')).toBeNull();
  });

  it('reads exchange rates and commodities as market data', () => {
    // The need side has to route there too, or the in-bucket nudge never fires
    // for the capability the function name classifies.
    expect(inferQueryBucket('commodity prices')).toBe('finance');
    expect(inferQueryBucket('eur usd exchange rate')).toBe('finance');
  });
});
