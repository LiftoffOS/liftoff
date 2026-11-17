// The curated capability taxonomy.
//
// A small set of vendor-agnostic buckets that organize the absorbed data-vendor
// surface, so discovery and the assistant can reason and browse in CAPABILITY
// terms, never vendor terms (the rollup's whole point). The skeleton is
// hand-curated — a deliberate product decision, the shape validated against the
// broader aggregator ecosystem's own top-level categories — while connectors
// are mapped into it programmatically. Adding a bucket or a connector mapping is
// part of onboarding a vendor, the same discipline as the executor's vendor
// sets.
//
// Classification, labeling, and need routing: it gives every candidate a
// vendor-agnostic capability label, and routes a need to its likely bucket
// (inferQueryBucket, reading each bucket's `cues`) so an on-target candidate is
// nudged ahead within its bucket — a tie-breaker that matters as the vendor set
// grows, bounded so it never overturns the judge's verdict or evidence.

interface CapabilityBucket {
  id: string;
  /** Vendor-agnostic label shown to the model and, later, in any browse UI. */
  displayName: string;
  description: string;
  /** Cue words that route a need to this bucket (lowercase, matched as
   *  substrings against the spec's target system / entity / operation). */
  cues: string[];
}

const CAPABILITY_BUCKETS: CapabilityBucket[] = [
  { id: 'social_media', displayName: 'Social media data', description: 'Public posts, profiles, comments, and trends from social platforms.', cues: ['social', 'tiktok', 'instagram', 'facebook', 'twitter', 'reddit', 'youtube', 'linkedin', 'snapchat', 'threads', 'douyin', 'bilibili', 'post', 'posts', 'profile', 'follower', 'followers', 'reel', 'reels', 'trend', 'trending', 'influencer'] },
  { id: 'lead_generation', displayName: 'Lead generation & enrichment', description: 'Finding and enriching people and companies: contacts, firmographics.', cues: ['lead', 'leads', 'prospect', 'enrich', 'enrichment', 'contact', 'contacts', 'firmographic', 'b2b', 'people search', 'find email', 'find phone'] },
  { id: 'search_seo', displayName: 'Web search & SEO', description: 'Web search results, keywords, backlinks, and SEO metrics.', cues: ['search', 'seo', 'keyword', 'keywords', 'backlink', 'backlinks', 'ranking', 'serp'] },
  { id: 'news', displayName: 'News', description: 'News articles and coverage across topics and companies.', cues: ['news', 'headline', 'headlines', 'article', 'articles', 'coverage', 'press'] },
  { id: 'ecommerce', displayName: 'E-commerce data', description: 'Marketplace products, prices, reviews, and sellers.', cues: ['ecommerce', 'product', 'products', 'price', 'prices', 'pricing', 'marketplace', 'amazon', 'ebay', 'walmart', 'etsy', 'seller'] },
  { id: 'crypto', displayName: 'Crypto data', description: 'Crypto prices, DeFi, on-chain analytics, and market signals.', cues: ['crypto', 'defi', 'token', 'tokens', 'onchain', 'on-chain', 'blockchain', 'nft', 'tvl', 'dex', 'coin'] },
  { id: 'finance', displayName: 'Market & financial data', description: 'Public market quotes, fundamentals, earnings, filings, screeners, exchange rates and commodity prices.', cues: ['stock', 'stocks', 'equity', 'equities', 'quote', 'quotes', 'ticker', 'earnings', 'dividend', 'dividends', 'sec', 'filing', 'filings', 'etf', 'fund', 'market', 'financial', 'fundamentals', 'forex', 'fx', 'currency', 'currencies', 'exchange rate', 'commodity', 'commodities', 'futures'] },
  { id: 'real_estate', displayName: 'Real estate data', description: 'Property listings, values, and housing-market data.', cues: ['real estate', 'property', 'properties', 'zillow', 'redfin', 'realtor', 'rent', 'mortgage', 'housing'] },
  { id: 'reviews', displayName: 'Reviews & reputation', description: 'Public reviews and ratings of products, companies, and services.', cues: ['review', 'reviews', 'rating', 'ratings', 'reputation', 'trustpilot', 'yelp', 'glassdoor'] },
  { id: 'jobs', displayName: 'Jobs & hiring data', description: 'Public job listings and hiring signals.', cues: ['job', 'jobs', 'hiring', 'vacancy', 'vacancies', 'recruit', 'posting', 'salary', 'salaries', 'compensation', 'internship', 'internships', 'volunteer'] },
  { id: 'compliance', displayName: 'Compliance & identity', description: 'Sanctions, PEP/AML screening, registry lookups, and identity checks.', cues: ['sanction', 'sanctions', 'pep', 'aml', 'compliance', 'kyc', 'identity', 'registry', 'vat', 'iban', 'watchlist'] },
  { id: 'web_scraping', displayName: 'Web scraping & extraction', description: 'Extracting structured data from arbitrary web pages and automations.', cues: ['scrape', 'scraping', 'extract', 'extraction', 'crawl', 'crawler', 'actor'] },
  { id: 'geo_reference', displayName: 'Location & reference data', description: 'Geocoding, weather, air quality, and other reference data.', cues: ['geocode', 'geocoding', 'address', 'location', 'weather', 'forecast', 'coordinates', 'air quality', 'aqi', 'pollution', 'temperature', 'climate'] },
  { id: 'automotive', displayName: 'Vehicles & automotive data', description: 'Vehicle listings, values, history reports, salvage auctions, and fuel prices.', cues: ['car', 'cars', 'vehicle', 'vehicles', 'vin', 'dealer', 'dealers', 'auto', 'automotive', 'truck', 'suv', 'mileage', 'odometer', 'salvage', 'auction', 'gas prices', 'fuel', 'diesel', 'trade-in', 'kelley', 'blue book'] },
  { id: 'ai_models', displayName: 'AI model benchmarks', description: 'Benchmarks, leaderboards, pricing and capabilities of AI models and providers.', cues: ['benchmark', 'benchmarks', 'leaderboard', 'leaderboards', 'llm', 'llms', 'ai model', 'ai models', 'language model', 'arena', 'elo', 'tokens per second', 'context window', 'model pricing'] },
];

const BUCKET_BY_ID = new Map(CAPABILITY_BUCKETS.map((b) => [b.id, b]));

/** Explicit connector-type → bucket for the absorbed vendors. The axis is a
 *  property of what the vendor serves, so it is stated, not inferred (mirrors
 *  PUBLIC_DATA_CONNECTOR_TYPES in sources.ts).
 *
 *  A MULTI-DOMAIN rung is deliberately absent here and must stay absent: the
 *  aggregator cards (`locus`) resell people search, SEO, crypto, market data
 *  and web reads behind ONE connector type, so no single bucket is true of the
 *  card and naming one would mislabel most of what it serves. Those are
 *  classified per FUNCTION instead (functionBucket below). */
const CONNECTOR_BUCKET: Record<string, string> = {
  tikhub: 'social_media',
  apify: 'web_scraping',
  gloria: 'crypto',
  defillama: 'crypto',
  nasdaq: 'finance',
  strale: 'compliance',
  google_trends: 'search_seo',
  // kadec0 spans search, crypto, filings, papers and domains; the bucket is
  // only the in-bucket relevance boost and its most-used tools are search and
  // scrape, so it sits with search. The judge decides fit per tool.
  kadec0: 'search_seo',
  pdl: 'lead_generation',
  peopledatalabs: 'lead_generation',
  hunterio: 'lead_generation',
  contactout: 'lead_generation',
  crunchbase: 'lead_generation',
  similarweb: 'search_seo',
  ahrefs: 'search_seo',
  firecrawl: 'web_scraping',
  scrapingbee: 'web_scraping',
  browseai: 'web_scraping',
  tavily: 'search_seo',
  exa: 'search_seo',
  webclaw: 'web_scraping',
};

/** Fallback from a catalog category name to a bucket, for connectors not in the
 *  explicit map above. */
const CATEGORY_BUCKET: Record<string, string> = {
  social: 'social_media', social_media: 'social_media',
  finance: 'finance', markets: 'finance', equities: 'finance',
  crypto: 'crypto', defi: 'crypto',
  news: 'news',
  ecommerce: 'ecommerce', commerce: 'ecommerce',
  search: 'search_seo', seo: 'search_seo',
  web_tools: 'web_scraping', scraping: 'web_scraping', scrapers: 'web_scraping',
  enrichment: 'lead_generation', people: 'lead_generation', sales: 'lead_generation', lead_generation: 'lead_generation',
  compliance: 'compliance',
  real_estate: 'real_estate',
  reviews: 'reviews',
};

/** The capability bucket for a connector, or null when nothing maps (the
 *  candidate is still ranked; it simply carries no capability label). */
export function classifyConnectorToBucket(connectorType: string, category?: string): string | null {
  const t = connectorType.toLowerCase();
  if (CONNECTOR_BUCKET[t]) return CONNECTOR_BUCKET[t];
  if (category && CATEGORY_BUCKET[category.toLowerCase()]) return CATEGORY_BUCKET[category.toLowerCase()];
  return null;
}

export function bucketById(id: string | null | undefined): CapabilityBucket | undefined {
  return id ? BUCKET_BY_ID.get(id) : undefined;
}

/** How strongly one bucket's cues match a text: how many distinct CONCEPTS of
 *  the bucket the text carries, and the longest cue among them.
 *
 *  Two properties, both because a cue list is a hand-written vocabulary rather
 *  than an orthogonal feature set:
 *
 *  - a matched cue that is a PREFIX of another matched cue of the same bucket
 *    does not count on its own. The lists carry singular and plural of one
 *    concept ('price' and 'prices', 'sanction' and 'sanctions', 'trend' and
 *    'trending'), and one word of the text matching both is one signal, not
 *    two. Counting it twice is what filed "commodity prices" under ecommerce
 *    ahead of the bucket the word 'commodity' names — a 2-to-1 win for a
 *    single word.
 *  - `longest` is the tie-break, the more specific word. Generic cues repeat
 *    across buckets on purpose ('price' in ecommerce, 'search' in search_seo,
 *    'market' in finance), so without it a tie is settled by which bucket
 *    happens to be declared first.
 *
 *  `wholeWord` is for a text that is its own words — a function NAME — where
 *  'fund' has no business matching a refund. Free text stays on substrings:
 *  a need is a sentence and its endings vary. */
function cueScore(
  haystack: string,
  cues: string[],
  wholeWord: boolean,
): { hits: number; longest: number; earliest: number } {
  const matched = cues
    .map((cue) => ({ cue, at: haystack.indexOf(wholeWord ? ` ${cue} ` : cue) }))
    .filter((m) => m.at >= 0);
  const concepts = matched.filter((m) => !matched.some((o) => o.cue !== m.cue && o.cue.startsWith(m.cue)));
  return {
    hits: concepts.length,
    longest: concepts.reduce((m, c) => Math.max(m, c.cue.length), 0),
    earliest: concepts.reduce((m, c) => Math.min(m, c.at), Number.MAX_SAFE_INTEGER),
  };
}

/** The bucket whose cues best match: most concepts first, then `byPosition` or
 *  specificity; null when none matches at all.
 *
 *  `byPosition` is for a text written DOMAIN-FIRST, which a function name is —
 *  `fuel_prices_get_…`, `commodity_daily_price`, `vehicle_history_get_value`,
 *  and every generated name whose prefix is its capability word. There the
 *  earliest match is the subject and anything after it qualifies the subject,
 *  which is a better reading than cue length: 'prices' is longer than 'fuel',
 *  so length alone would file every fuel-price read under ecommerce. Free text
 *  has no such order and keeps the specificity rule. */
function bestBucket(haystack: string, wholeWord: boolean, byPosition: boolean): string | null {
  let best: { id: string; hits: number; longest: number; earliest: number } | null = null;
  for (const b of CAPABILITY_BUCKETS) {
    const score = cueScore(haystack, b.cues, wholeWord);
    if (score.hits === 0) continue;
    const better = !best
      || score.hits > best.hits
      || (score.hits === best.hits && (byPosition
        ? score.earliest < best.earliest || (score.earliest === best.earliest && score.longest > best.longest)
        : score.longest > best.longest));
    if (better) best = { id: b.id, ...score };
  }
  return best?.id ?? null;
}

/** Route a free-text need to its most-likely bucket by cue overlap; null when
 *  nothing clearly matches, so an ambiguous need simply gets no routing and
 *  ranks on relevance alone. */
export function inferQueryBucket(text: string): string | null {
  return bestBucket(text.toLowerCase(), false, false);
}

/** The bucket a single FUNCTION belongs to, read off its own name; null when
 *  nothing matches and the connector's bucket should stand instead.
 *
 *  This is sound only because of the naming discipline the platform-funded
 *  cards already keep: a function is named for the CAPABILITY and never for
 *  the vendor (`commodity_daily_price`, `backlinks_summary`, `people_search`),
 *  which is the same vocabulary the buckets' cues are written in. It is the
 *  only classification a multi-domain rung can have that is true of each of
 *  its calls — see CONNECTOR_BUCKET above — and it is read from the name we
 *  already ship rather than a second table that would have to be kept in step
 *  with it.
 *
 *  It matches WHOLE WORDS where the need side matches substrings (cueScore's
 *  `wholeWord`): a name is its own words, so 'fund' has no business matching a
 *  refund and 'fx' none matching any word that happens to contain it. And it
 *  settles a tie by POSITION rather than by cue length (bestBucket's
 *  `byPosition`), because a name is written subject-first.
 *
 *  Residual ambiguity is expected and tolerable: where two buckets tie on both
 *  concept count and specificity (`crypto_search`) the earlier one wins and the
 *  label is arguable. This is a ranking and partitioning aid, not a taxonomy —
 *  a bucket only ever nudges relevance within a tie band, names the candidate
 *  for the model, and partitions one card's functions so no domain it serves
 *  is crowded out by another. */
export function functionBucket(functionName: string): string | null {
  const words = functionName.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  if (words.length === 0) return null;
  return bestBucket(` ${words.join(' ')} `, true, true);
}
