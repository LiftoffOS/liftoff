// Which Locus providers the platform resells as capabilities, and under what
// names. The generator (scripts/locus-catalog-sync.ts) reads each provider's
// catalog document from the Locus account and writes generated/locus-parse.ts
// from this list; nothing here is a function, only the shape of the names.
//
// A `prefix` is what the capability IS — the person's word for the data,
// never the vendor's name — and every endpoint of the provider becomes
// `<prefix>_<endpoint>`. `brands` are the vendor's own names, scrubbed out of
// every generated description, because the model must never learn which
// supplier answers (the same rule as generated/locus.ts). `bucket` is the
// capability-tree bucket platform-backend routes the need to.
//
// A provider must also be ENABLED on the Locus account (they start disabled),
// which the generator checks and reports; it never enables anything itself.

export interface LocusParseProvider {
  /** The Locus provider id (catalog slug prefix). */
  provider: string;
  /** Vendor-free capability word the function names start with. */
  prefix: string;
  /** The vendor's names and domains, scrubbed from descriptions. */
  brands: string[];
  bucket: string;
  /** Endpoint slugs (the part after `provider/`) left out. */
  exclude?: string[];
}

export const LOCUS_PARSE_ALLOWLIST: LocusParseProvider[] = [
  // ── Automotive ──────────────────────────────────────────────────────────
  { provider: 'parse-carfax-com-api-1c2d366b', prefix: 'vehicle_history', brands: ['carfax'], bucket: 'automotive' },
  { provider: 'parse-cars-com-api-ccacb270', prefix: 'car_listings', brands: ['cars.com', 'cars com'], bucket: 'automotive' },
  { provider: 'parse-kbb-com-api-0284bc02', prefix: 'car_values', brands: ['kelley blue book', 'kbb'], bucket: 'automotive' },
  { provider: 'parse-edmunds-com-api-6d4b8554', prefix: 'car_reviews', brands: ['edmunds'], bucket: 'automotive' },
  { provider: 'parse-bid-cars-api-5b8ead15', prefix: 'salvage_auctions', brands: ['bid.cars', 'bidcars', 'bid cars'], bucket: 'automotive' },
  { provider: 'parse-gasprices-aaa-com-api-a0d5d03f', prefix: 'fuel_prices', brands: ['aaa'], bucket: 'automotive' },
  // ── Real estate ─────────────────────────────────────────────────────────
  { provider: 'parse-zillow-com-api-082cc2d5', prefix: 'home_listings', brands: ['zillow', 'zestimate'], bucket: 'real_estate' },
  { provider: 'parse-homes-com-api-e536d79b', prefix: 'home_search', brands: ['homes.com', 'homes com'], bucket: 'real_estate' },
  { provider: 'parse-loopnet-com-api-9d3a7974', prefix: 'commercial_property', brands: ['loopnet'], bucket: 'real_estate' },
  // ── Jobs ────────────────────────────────────────────────────────────────
  { provider: 'parse-indeed-com-api-ef57dcec', prefix: 'job_search', brands: ['indeed'], bucket: 'jobs' },
  { provider: 'parse-wellfound-com-api-d395faef', prefix: 'startup_jobs', brands: ['wellfound', 'angellist', 'angel list'], bucket: 'jobs' },
  { provider: 'parse-levels-fyi-api-543e5df9', prefix: 'compensation', brands: ['levels.fyi', 'levels fyi'], bucket: 'jobs' },
  { provider: 'parse-builtin-com-api-86aeeb18', prefix: 'tech_jobs', brands: ['built in', 'builtin'], bucket: 'jobs' },
  { provider: 'parse-idealist-org-api-f95f3567', prefix: 'nonprofit_jobs', brands: ['idealist'], bucket: 'jobs' },
  { provider: 'parse-web3-career-api-e485a330', prefix: 'web3_jobs', brands: ['web3.career', 'web3 career'], bucket: 'jobs' },
  // ── Reviews and software directories ────────────────────────────────────
  { provider: 'parse-g2-com-api-02e11b38', prefix: 'software_reviews', brands: ['g2'], bucket: 'reviews' },
  { provider: 'parse-capterra-com-api-786d1eda', prefix: 'software_directory', brands: ['capterra'], bucket: 'reviews' },
  { provider: 'parse-getapp-com-api-96bffcf5', prefix: 'software_catalog', brands: ['getapp'], bucket: 'reviews' },
  { provider: 'parse-trustpilot-com-api-430e0263', prefix: 'business_reviews', brands: ['trustpilot'], bucket: 'reviews' },
  // ── Markets ─────────────────────────────────────────────────────────────
  { provider: 'parse-marketbeat-com-api-7efa2b5b', prefix: 'market_research', brands: ['marketbeat'], bucket: 'finance' },
  { provider: 'parse-secform4-com-api-a56dfc20', prefix: 'insider_trading', brands: ['secform4'], bucket: 'finance' },
  { provider: 'parse-stockanalysis-com-api-c9e8ac45', prefix: 'stock_fundamentals', brands: ['stockanalysis'], bucket: 'finance' },
  { provider: 'parse-finviz-com-api-09c62661', prefix: 'stock_screener', brands: ['finviz'], bucket: 'finance' },
  { provider: 'parse-yahoofinance-com-api-417d966a', prefix: 'stock_market', brands: ['yahoo finance', 'yahoo'], bucket: 'finance' },
  // ── Weather and air ─────────────────────────────────────────────────────
  { provider: 'parse-accuweather-com-api-d84777ff', prefix: 'weather_forecast', brands: ['accuweather'], bucket: 'geo_reference' },
  { provider: 'parse-iqair-com-api-c60726f6', prefix: 'air_quality', brands: ['iqair'], bucket: 'geo_reference' },
  { provider: 'parse-wunderground-com-api-31a45835', prefix: 'weather_history', brands: ['wunderground', 'weather underground'], bucket: 'geo_reference' },
  // ── Crypto and prediction markets ───────────────────────────────────────
  // Both are reached through Locus, so the
  // charge lands on the prepaid credit balance and the platform's x402 wallet
  // is not touched -- the aggregator is the purchaser on the x402 lanes it
  // resells, which is what keeps this pay-as-you-go with no commitment.
  { provider: 'parse-polymarket-com-api-356a9c18', prefix: 'prediction_markets', brands: ['polymarket'], bucket: 'crypto' },
  { provider: 'parse-app-hyperliquid-xyz-api-0ef2734c', prefix: 'derivatives_market', brands: ['hyperliquid'], bucket: 'crypto' },
  // ── Company and AI-model data ───────────────────────────────────────────
  { provider: 'parse-thecompaniesapi-com-api-54ff4b40', prefix: 'company_database', brands: ['thecompaniesapi', 'the companies api'], bucket: 'lead_generation' },
  { provider: 'parse-artificialanalysis-ai-api-38112545', prefix: 'ai_model_benchmarks', brands: ['artificial analysis', 'artificialanalysis'], bucket: 'ai_models' },
  { provider: 'parse-lmarena-ai-api-f4504720', prefix: 'ai_model_leaderboard', brands: ['lmarena', 'lm arena', 'chatbot arena'], bucket: 'ai_models' },
];
