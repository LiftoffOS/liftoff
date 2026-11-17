import { getEntitlementsClient } from '../../entitlements-client/service';
import { logger } from '../../infrastructure/logging';
import { GLOBAL_TENANT_SENTINEL } from './global-flags';
import type { WebVendor } from './types';

/** The budget Perplexity's Agent API tools spend from.
 *
 *  A rate limit is a property of the VENDOR'S ENDPOINT, not of the name we
 *  gave a tool. `fetch_url`, `web_search`, `people_search` and
 *  `finance_search` are four tool types on one `POST /v1/agent`, under one
 *  per-key request rate, and this table gave each of them its own hourly
 *  figure — so four independent budgets were spent against one real one and
 *  the vendor refused whichever call lost the race. A run's `web_fetch_advanced`
 *  calls starved `web_finance_search` out of the shared second twelve times
 *  while succeeding themselves, one second apart in the same trace.
 *
 *  The figure is measured, not published: the vendor sends
 *  `x-ratelimit-limit: 1` with a reset about a second out, and a 429 carrying
 *  `retry-after: 1`. Raise it for an environment on a higher tier with the
 *  `web_fetch_perplexity_rate_per_hour_perplexity_agent_api` sentinel flag. */
export const PERPLEXITY_AGENT_BUDGET = 'perplexity_agent_api';

/** Tool name -> the budget it spends from, per vendor. A tool absent here
 *  spends from a budget of its own name, which is the common case.
 *
 *  Perplexity's entries are the four tool types that POST `/v1/agent`
 *  (perplexity-client.ts documents the endpoint per method). `web_search` is
 *  `POST /search` and `web_deep_research` is `POST /async/chat/completions`:
 *  separate endpoints, separate limits, so they are deliberately not here.
 *  `web_extract` has no Perplexity implementation at all. */
const SHARED_RATE_BUDGET: Partial<Record<WebVendor, Readonly<Record<string, string>>>> = {
  perplexity: {
    web_fetch_advanced: PERPLEXITY_AGENT_BUDGET,
    web_research:       PERPLEXITY_AGENT_BUDGET,
    web_people_search:  PERPLEXITY_AGENT_BUDGET,
    web_finance_search: PERPLEXITY_AGENT_BUDGET,
  },
};

/** Which budget a call spends from. The token bucket keys on this rather than
 *  on the tool name, so tools sharing a vendor endpoint share its ceiling. */
export function rateBudgetFor(vendor: WebVendor, toolName: string): string {
  return SHARED_RATE_BUDGET[vendor]?.[toolName] ?? toolName;
}

// Vendor-imposed global caps. Liftoff does not impose per-tenant or per-agent
// caps — those would throttle paying usage. Rate-per-hour defaults match
// vendor-published rate limits and exist ONLY to avoid 429s from the vendor.
const DEFAULTS: Record<WebVendor, {
  global: number;
  ratePerHour: Record<string, number>;
  /** How many calls may go AT ONCE, per budget. Absent means the hour's whole
   *  allowance may burst, which is what `ratePerHour` alone meant and is only
   *  safe for a vendor whose real ceiling is far above our traffic. Set it
   *  wherever the vendor publishes a burst, because a rate with no burst bound
   *  does not pace anything until the bucket happens to be empty. */
  burst?: Record<string, number>;
}> = {
  webclaw:     { global: 50, ratePerHour: { web_fetch_advanced: 200 } },
  firecrawl:   { global: 2,  ratePerHour: { web_fetch_advanced: 100, web_extract: 50, web_research: 30 } },  // Free plan defaults
  // Perplexity serves three endpoints and each has its own request rate. The
  // Agent API's tools share ONE budget (see PERPLEXITY_AGENT_BUDGET below);
  // /search and the async deep-research endpoint carry their own.
  perplexity:  {
    global: 50,
    ratePerHour: {
      [PERPLEXITY_AGENT_BUDGET]: 3_600,   // 1 RPS, measured off x-ratelimit-limit
      web_search:          180_000,       // POST /search — 50 RPS sustained * 3600
      web_deep_research:   300,           // POST /async/chat/completions — Tier 0 = 5 RPM
    },
    // The Agent API answers `x-ratelimit-limit: 1`: one call in flight per
    // window, and a second one fired alongside it gets 429 with
    // `retry-after: 1`. Without this the bucket's capacity is the hour's whole
    // allowance, so 3,600 calls are admitted back to back and a run of a
    // hundred never reaches the pacing at all.
    burst: { [PERPLEXITY_AGENT_BUDGET]: 1 },
  },
  // xAI serves two web tools on the platform's own xAI account: web_x_search,
  // and web_search for a Grok run whose engine attaches no hosted search. No
  // published per-key rate to mirror, so these are spend ceilings rather than
  // 429 guards — a call costs its tokens plus a $5/1,000 tool fee (a live
  // web_search billed $0.045), so 500/hr per tenant caps one tenant at roughly
  // $25 an hour per tool against a shared account.
  xai:         { global: 25, ratePerHour: { web_x_search: 500, web_search: 500 } },
  anchor:      { global: 25, ratePerHour: { web_extract: 50, web_task: 10, web_research: 5, web_diff: 20, web_identity_connect: 10, web_session_save: 10 } },
  browserbase: { global: 25, ratePerHour: { web_extract: 50, web_task: 10, web_diff: 20 } },
  // `global` is the plan's CONCURRENT-SESSION ceiling, which for Browser Use is
  // the binding limit rather than a request rate: 3 sessions on a free account,
  // 10 after a first top-up, 25 / 200 / 500 on the paid tiers. 10 matches the
  // post-top-up floor so a tenant that has only ever added credit cannot walk
  // into a 429. Raise it per-tenant when the plan is raised. No web_extract /
  // web_diff / web_research entries: Browser Use has no primitive for any of
  // them, so those chains never route to it.
  browser_use: { global: 10, ratePerHour: { web_fetch_advanced: 100, web_task: 10 } },
  // Steel's Launch plan allows 10 concurrent sessions on the platform key.
  steel: { global: 10, ratePerHour: { web_fetch_advanced: 100, web_task: 10 } },
  // The gateway publishes no rate; these are spend ceilings against the
  // platform x402 wallet. connector-service refuses a vendor past $10 a day,
  // which at $0.01 a call is 1,000 calls platform-wide; 60 an hour per tenant
  // per tool sits inside that, and the rung runs only when every vendor ahead
  // of it is out.
  browserbase_x402: { global: 5, ratePerHour: { web_fetch_advanced: 60, web_search: 60 } },
  // Firecrawl through the platform's Locus key: a scrape is $0.003, a search
  // under a cent, an extract a cent or two; the Locus account carries the
  // monthly ceiling. Concurrency matches the BYOK Firecrawl client.
  locus_web: { global: 10, ratePerHour: { web_fetch_advanced: 300, web_search: 120, web_extract: 60 } },
  // Exa's x402 API through the platform's Locus key: the overflow behind the
  // platform's own Exa key, so it carries Exa's own ceilings.
  locus_exa: { global: 10, ratePerHour: { web_fetch_advanced: 600, web_research: 200 } },
  // Tavily Researcher (free) plan: 1,000 credits/mo (per Tavily ACCOUNT,
  // shared across all keys in that account — we provision one account per
  // env, see §3.6). Tavily renamed the free tier to "Researcher" — confirmed
  // by /usage response (account.current_plan).
  // Tavily per-key rate limits: 100 req/min on dev (6,000/hr aggregate),
  // 1,000 req/min on prod (60,000/hr aggregate). The per-tenant defaults
  // below × tenant count stays well under either env's per-key cap, so the
  // monthly credit ceiling (not rate) is the binding constraint. Bump on
  // plan upgrade.
  tavily:      { global: 2,  ratePerHour: { web_fetch_advanced: 100, web_research: 50 } },
  // Exa published rate limits (verified Exa OpenAPI docs 2026-06-03):
  // /contents = 100 QPS, /answer = 10 QPS, /search = 10 QPS. We use
  // /contents for web_fetch_advanced and /answer for web_research, so the
  // binding per-key ceiling is 10 QPS on the answer side and 100 QPS on
  // the contents side. Both translate to monthly $-spend being the
  // realistic binding constraint at our tenant counts; rate caps only
  // matter under burst.
  //
  // global=10 chosen as a conservative per-vendor-concurrency cap: it
  // matches the lower of the two endpoint QPS ceilings (answer=10) and
  // stays below the Liftoff-wide Postgres connection budget the
  // admission layer relies on.
  //
  // ratePerHour: web_fetch_advanced=600 (10/min sustained, well under
  // /contents 100 QPS = 360,000/hr); web_research=200 (3.3/min, well
  // under /answer 10 QPS = 36,000/hr).
  exa:         { global: 10, ratePerHour: { web_fetch_advanced: 600, web_research: 200 } },
  // OpenAI o3-deep-research — published Tier 1 = 500 RPM, but deep_research is
  // long-running. global=5 mirrors the per-vendor concurrency ceiling we use
  // for paygo vendors; 60 RPH (1 RPM sustained) is conservative.
  openai:      { global: 5, ratePerHour: { web_deep_research: 60 } },
  // Google Gemini Interactions API (preview). Rate limits undocumented for
  // preview agents — start with same conservative ceiling as OpenAI; tune
  // via sentinel flags after first week's observation.
  google:      { global: 5, ratePerHour: { web_deep_research: 60 } },
};

// In-memory cache for the sentinel-row flags. Without this, every web-tool
// call would round-trip to the entitlements-client (and through it to the DB)
// for the flags read. Even with a fast DB it's a needless hop on a hot path.
//
// TTL = 10s as the upper bound. The subscriber calls invalidateFlagsCache()
// immediately after writing the sentinel row, so the real propagation latency
// is ≈event-delivery time (sub-second under healthy Pub/Sub), not the TTL.
// The TTL exists only as a fallback in case an event is missed entirely.
const FLAGS_CACHE_TTL_MS = 10_000;
let flagsCache: { value: Record<string, unknown>; expiresAt: number } | null = null;

/** Invalidate the in-memory sentinel-flag cache. Called by:
 *   - `events/subscriber.ts` after writing the sentinel row, so operator PUTs
 *     propagate at event-delivery latency rather than the cache TTL
 *   - tests (under the legacy `_resetFlagsCache` alias)
 */
export function invalidateFlagsCache(): void { flagsCache = null; }
export const _resetFlagsCache = invalidateFlagsCache;

export async function getCachedSentinelFlags(): Promise<Record<string, unknown>> {
  if (flagsCache && flagsCache.expiresAt > Date.now()) return flagsCache.value;
  const value = (await getEntitlementsClient().getFeatureFlags(GLOBAL_TENANT_SENTINEL)) as Record<string, unknown> | null | undefined;
  const resolved = value ?? {};
  flagsCache = { value: resolved, expiresAt: Date.now() + FLAGS_CACHE_TTL_MS };
  return resolved;
}

function readNum(flags: Record<string, unknown>, key: string): number | undefined {
  // Numeric values land under the `<key>_value` suffix per A4's encoding.
  const v = flags[`${key}_value`];
  return typeof v === 'number' && v > 0 ? v : undefined;
}

export async function getVendorConcurrencyLimits(vendor: WebVendor): Promise<{ maxConcurrentGlobal: number }> {
  const f = await getCachedSentinelFlags();
  return {
    maxConcurrentGlobal: readNum(f, `web_fetch_${vendor}_max_concurrent_global`) ?? DEFAULTS[vendor].global,
  };
}

/** The hourly ceiling for a call, read against its BUDGET.
 *
 *  An operator override on the tool's own name is still honoured for a tool
 *  that shares a budget, so a flag set before the budget existed keeps
 *  working — but the budget's own flag wins, because that is the ceiling the
 *  vendor actually enforces. */
export async function getVendorRatePerHour(vendor: WebVendor, toolName: string): Promise<number | undefined> {
  const f = await getCachedSentinelFlags();
  const budget = rateBudgetFor(vendor, toolName);
  const rates = DEFAULTS[vendor].ratePerHour;
  return readNum(f, `web_fetch_${vendor}_rate_per_hour_${budget}`)
    ?? (budget === toolName ? undefined : readNum(f, `web_fetch_${vendor}_rate_per_hour_${toolName}`))
    ?? rates[budget]
    ?? rates[toolName];
}

/** How many calls of this budget may go at once.
 *
 *  Undefined when the vendor publishes no burst and our traffic is nowhere
 *  near its ceiling, in which case the bucket falls back to letting the
 *  hour's allowance burst — the behaviour every vendor here had before a
 *  1-RPS one arrived. */
export async function getVendorBurst(vendor: WebVendor, toolName: string): Promise<number | undefined> {
  const f = await getCachedSentinelFlags();
  const budget = rateBudgetFor(vendor, toolName);
  const bursts = DEFAULTS[vendor].burst;
  return readNum(f, `web_fetch_${vendor}_burst_${budget}`)
    ?? (budget === toolName ? undefined : readNum(f, `web_fetch_${vendor}_burst_${toolName}`))
    ?? bursts?.[budget]
    ?? bursts?.[toolName];
}

/**
 * Generic typed-object accessor for sentinel-flag JSON payloads (D8/D9).
 * Validates the raw value against a type-guard; on validation failure logs
 * the bad shape and falls back to the default. Caller passes the key
 * WITHOUT the `_value` suffix.
 */
export async function readTypedFlag<T>(
  key: string,
  validate: (raw: unknown) => raw is T,
  fallback: T,
): Promise<T> {
  const flags = await getCachedSentinelFlags();
  const raw = flags[`${key}_value`];
  if (validate(raw)) return raw;
  if (raw !== undefined) {
    logger.warn({ key, raw }, 'sentinel_flag_invalid_using_fallback');
  }
  return fallback;
}

// `isEffortRoutingEnabled` lives in `./global-flags` alongside the other
// vendor flag accessors. Importing it here would create no cycle (limits-
// config already imports GLOBAL_TENANT_SENTINEL from global-flags) but
// keeping it in global-flags consolidates the migration-flag surface.
