// Capability discovery — live source retrieval.
//
// One function per source, each with its own timeout and fail-to-empty: a
// source being down degrades the candidate list, never the caller. Retrieval
// is the SOURCE's job (its search ranks its own catalog); ours starts at
// scoring. Nothing here mirrors a catalog — stats and listings are read at
// query time, which is what keeps them true while catalogs drift.

import { log } from '../infrastructure/logging';
import { getCatalog } from '../connectors/connector-service-client';
import { fetchRegistry } from '../connectors/connector-type-registry';
import { classifyConnectorToBucket, functionBucket, inferQueryBucket } from './capability-tree';
import { PLATFORM_EXECUTABLE_VENDORS, BYO_ONLY_VENDORS } from './vendor-execution';
import { switchedOffVendors } from './vendor-gate';

/** How much an on-target candidate (its bucket == the need's inferred bucket)
 *  is nudged in relevance. Bounded and modest: it re-orders within a tie band,
 *  never overturns the judge's verdict or usage evidence downstream. */
const IN_BUCKET_BOOST = 1.25;
import { PLATFORM_WEB_TOOLS } from '../internal-agents/platform-web-tools';
import {
  APIFY_COMPUTE_ESTIMATE_USD,
  APIFY_NOMINAL_ITEMS,
  MAX_CANDIDATES_PER_SOURCE,
  SOURCE_TIMEOUT_MS,
} from './config';
import type { Candidate, CapabilityMode, CapabilitySpec } from './types';

/** Function-level candidates kept per connector PER BUCKET (see the cut in
 *  searchConnectorRegistry). Three is what a single-domain connector kept
 *  before the cut became per bucket, so a one-bucket card is unchanged. */
const FUNCTIONS_PER_BUCKET = 3;

const APIFY_STORE_URL = 'https://api.apify.com/v2/store';

/** Store item fields we read — the response carries much more. */
interface ApifyStoreItem {
  name?: string;
  username?: string;
  title?: string;
  description?: string;
  stats?: {
    totalUsers30Days?: number;
    lastRunStartedAt?: string;
    publicActorRatingCount?: number;
    publicActorRating?: number;
  };
  /** The store's own price for the actor: PRICE_PER_DATASET_ITEM
   *  (`pricePerUnitUsd` an item), PAY_PER_EVENT (a one-time start event plus
   *  a primary per-result event, the price on the event or in its FREE
   *  tier), FLAT_PRICE_PER_MONTH (a rental), or none (compute only). */
  currentPricingInfo?: {
    pricingModel?: string;
    pricePerUnitUsd?: number;
    pricingPerEvent?: {
      actorChargeEvents?: Record<string, {
        eventPriceUsd?: number;
        isOneTimeEvent?: boolean;
        isPrimaryEvent?: boolean;
        eventTieredPricingUsd?: Record<string, { tieredEventPriceUsd?: number }>;
      }>;
    };
  };
}

type ChargeEvent = NonNullable<NonNullable<NonNullable<ApifyStoreItem['currentPricingInfo']>['pricingPerEvent']>['actorChargeEvents']>[string];

function eventPriceUsd(e: ChargeEvent): number | undefined {
  const direct = e.eventPriceUsd;
  if (typeof direct === 'number' && direct >= 0) return direct;
  const free = e.eventTieredPricingUsd?.FREE?.tieredEventPriceUsd;
  return typeof free === 'number' && free >= 0 ? free : undefined;
}

/** What one typical call of a store actor costs, from the store's own price:
 *  a per-item price at a typical result count; a pay-per-event actor's start
 *  event plus its primary event at that count; a rental or an unpriced actor
 *  at the compute estimate. Never null: an actor with no price of its own
 *  still costs compute, and "no price" ranking level with free is what let a
 *  store actor outrank a priced function at equal fit. Every figure here
 *  depends on how many results a call returns, so all are estimates. */
export function apifyPrice(info: ApifyStoreItem['currentPricingInfo']): NonNullable<Candidate['price']> {
  const model = info?.pricingModel;
  if (model === 'PRICE_PER_DATASET_ITEM' && typeof info?.pricePerUnitUsd === 'number' && info.pricePerUnitUsd > 0) {
    return { type: 'PER_RESULT', usd: info.pricePerUnitUsd * APIFY_NOMINAL_ITEMS, estimated: true };
  }
  if (model === 'PAY_PER_EVENT') {
    const events = Object.values(info?.pricingPerEvent?.actorChargeEvents ?? {});
    const oneTime = events.filter((e) => e.isOneTimeEvent === true).map(eventPriceUsd).filter((v): v is number => v !== undefined);
    const perItem = events.filter((e) => e.isOneTimeEvent !== true);
    const primary = perItem.find((e) => e.isPrimaryEvent === true) ?? perItem[0];
    const item = primary ? eventPriceUsd(primary) : undefined;
    if (item !== undefined || oneTime.length > 0) {
      const usd = oneTime.reduce((a, b) => a + b, 0) + (item ?? 0) * APIFY_NOMINAL_ITEMS;
      return { type: 'PER_RESULT', usd, estimated: true };
    }
  }
  return { type: 'PER_CALL', usd: APIFY_COMPUTE_ESTIMATE_USD, estimated: true };
}

/** Derive 1–3 short search strings from the spec. The source's own relevance
 *  search does retrieval; these only need to land in its lexical field
 *  (title/name/description/readme).
 *
 *  A named platform is also queried BARE. The store's search is lexical, and
 *  the words a need is phrased in decide what comes back: "reddit forum
 *  posts" returns forum scrapers for other sites, "reddit keyword search
 *  recent public posts" returns actors nobody runs, and the platform's
 *  well-used post scrapers appear under neither. The bare name returns the
 *  platform's most-used actors whatever the phrasing, and the judge — not
 *  the retrieval — decides which of them fit the operation and the entity. */
export function deriveSearchQueries(spec: CapabilitySpec): string[] {
  const sys = (spec.targetSystem ?? '').trim();
  const op = spec.operation.trim();
  const entity = spec.entity.trim();
  const queries = new Set<string>();
  if (sys) queries.add(`${sys} ${entity}`.trim());
  queries.add(`${sys} ${op}`.trim());
  if (sys) queries.add(sys);
  if (!sys) queries.add(`${entity} ${op}`.trim());
  return [...queries].filter((q) => q.length > 1).slice(0, 3);
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** Live Apify Store search. Store actors are public-web extraction by nature,
 *  so every candidate carries mode 'public_data' — an own_account spec never
 *  matches one, which the scorer's hard mode filter enforces. */
export async function searchApifyStore(
  spec: CapabilitySpec,
  opts: { timeoutMs?: number } = {},
): Promise<Candidate[]> {
  const timeoutMs = opts.timeoutMs ?? SOURCE_TIMEOUT_MS;
  const perQuery = Math.ceil(MAX_CANDIDATES_PER_SOURCE / 2);
  // Queries fan out in PARALLEL, each under the same per-fetch timeout, so the
  // slowest query bounds the whole search instead of the queries summing —
  // and one failed query costs only its own results.
  const pages = await Promise.all(
    deriveSearchQueries(spec).map(async (q): Promise<ApifyStoreItem[]> => {
      try {
        const url = `${APIFY_STORE_URL}?search=${encodeURIComponent(q)}&sortBy=relevance&limit=${perQuery}`;
        const resp = await fetchWithTimeout(url, timeoutMs);
        if (!resp.ok) return [];
        const body = (await resp.json()) as { data?: { items?: ApifyStoreItem[] } };
        return body.data?.items ?? [];
      } catch (error) {
        log.warn({ error, query: q }, 'capability-discovery: apify store search failed');
        return [];
      }
    }),
  );

  const terms = specTerms(spec);
  const out = new Map<string, Candidate>();
  // Round-robin across the queries rather than page by page, so each query
  // contributes to the pool under the cap instead of the last one being cut
  // off entirely.
  const interleaved: ApifyStoreItem[] = [];
  const longest = Math.max(0, ...pages.map((p) => p.length));
  for (let i = 0; i < longest; i++) {
    for (const page of pages) if (page[i]) interleaved.push(page[i]);
  }
  for (const item of interleaved) {
    if (out.size >= MAX_CANDIDATES_PER_SOURCE) break;
    if (!item.name || !item.username) continue;
    const ref = `${item.username}/${item.name}`;
    if (out.has(ref)) continue;
    out.set(ref, {
      source: 'apify_store',
      sourceRef: ref,
      title: item.title ?? item.name,
      description: item.description ?? '',
      mode: 'public_data',
      relevance: relevanceOf(terms, `${item.title ?? item.name} ${ref}`, item.description ?? ''),
      price: apifyPrice(item.currentPricingInfo),
      stats: {
        rating: item.stats?.publicActorRating,
        users30d: item.stats?.totalUsers30Days,
        lastRunAt: item.stats?.lastRunStartedAt,
      },
    });
  }
  return [...out.values()];
}

/** Connector categories whose tools reach PUBLIC third-party data. Everything
 *  else is an own-account system: the credential is the user's and so is the
 *  data behind it. Same platform name, different capability — the axis this
 *  service exists to keep straight. */
const PUBLIC_DATA_CATEGORIES = new Set(['web_tools']);

/** Data-vendor connector types whose whole purpose is public-data access,
 *  regardless of catalog category. Kept here (not inferred) because the axis
 *  is a property of what the vendor serves, not of how the catalog groups it. */
const PUBLIC_DATA_CONNECTOR_TYPES = new Set([
  'apify', 'tikhub', 'pdl', 'hunterio', 'contactout', 'crunchbase',
  'nasdaq', 'ycombinator', 'defillama', 'gloria', 'strale', 'browseai', 'firecrawl', 'scrapingbee',
  'tavily', 'exa', 'webclaw', 'similarweb', 'ahrefs',
  // The x402 pay-per-call vendors (catalog category `data`). Public-data
  // mode is what makes the platform-executor allowlist below apply to them:
  // google_trends and kadec0 pass it; browserbase_x402 does not and is
  // therefore never a candidate — it is reached only as the tenant runtime's
  // last web-fetch rung, behind the platform browser.
  'google_trends', 'kadec0', 'browserbase_x402',
  // The aggregator rungs (catalog category `data`): the platform's own prepaid
  // account at a reseller of key-based vendors. Public-data mode puts them
  // under the platform-executor allowlist, where both are listed.
  'locus', 'vaaya',
]);

function connectorMode(type: string, category: string | undefined): CapabilityMode {
  if (PUBLIC_DATA_CONNECTOR_TYPES.has(type)) return 'public_data';
  if (category && PUBLIC_DATA_CATEGORIES.has(category)) return 'public_data';
  return 'own_account';
}

/** Query terms with weights: the platform name is the strongest intent signal,
 *  the entity next, the operation verb least (verbs are common across tools). */
export function specTerms(spec: CapabilitySpec): Array<{ term: string; weight: number }> {
  const byTerm = new Map<string, number>();
  const add = (text: string, weight: number) => {
    for (const t of text.toLowerCase().split(/[^a-z0-9]+/).filter((x) => x.length > 2)) {
      byTerm.set(t, Math.max(byTerm.get(t) ?? 0, weight));
    }
  };
  if (spec.targetSystem) add(spec.targetSystem, 3);
  add(spec.entity, 2);
  add(spec.operation, 1);
  return [...byTerm].map(([term, weight]) => ({ term, weight }));
}

/** Cheap query-relevance (Stage-2 pre-rank). A term hit in the STRONG text —
 *  the connector/function/tool NAME — counts double a hit in the WEAK text
 *  (description, objects, capabilities): the name is the precise identifier,
 *  the rest is prose. This is what keeps `tiktok_*` above `bilibili_*` for a
 *  TikTok query and lets a Composio-managed connector (gmail) surface on its
 *  metadata alone. */
export function relevanceOf(
  terms: Array<{ term: string; weight: number }>,
  strong: string,
  weak: string,
): number {
  const s = strong.toLowerCase();
  const w = weak.toLowerCase();
  let score = 0;
  for (const { term, weight } of terms) {
    if (s.includes(term)) score += weight * 2;
    else if (w.includes(term)) score += weight;
  }
  return score;
}

/** Search over the FULL connector catalog — native AND Composio-managed.
 *  Function-level candidates for connectors with a generated function registry
 *  (tikhub/nasdaq/strale/…); connector-level candidates for Composio-managed
 *  connectors (gmail/salesforce/…) whose tools are enumerated by Composio, not
 *  us, so they have no registry function names — matched on their catalog
 *  metadata (displayName, description, objectsCovered, capabilities). Everything
 *  is scored for relevance and truncated by it, so the wrong-mode/off-topic
 *  bulk never reaches the judge. The judge, not this filter, decides final fit. */
export async function searchConnectorRegistry(spec: CapabilitySpec): Promise<Candidate[]> {
  try {
    const [catalog, registry, off] = await Promise.all([getCatalog(), fetchRegistry(), switchedOffVendors()]);
    const terms = specTerms(spec);
    const queryBucket = inferQueryBucket(`${spec.targetSystem ?? ''} ${spec.entity} ${spec.operation}`);
    const out: Candidate[] = [];
    for (const def of catalog.connectors) {
      const connectorType = def.type;
      const meta = registry.get(connectorType);
      const mode = connectorMode(connectorType, def.category as string | undefined);
      // A vendor is a vendor-hidden capability ONLY when the platform holds its
      // key — PLATFORM_EXECUTABLE_VENDORS, the set that executes via
      // `internal:<type>`. Require that POSITIVELY for every PUBLIC-DATA
      // candidate (an allowlist, not a blacklist): a public-data connector with
      // no platform executor — pdl, hunter, contactout, crunchbase, saperly, and
      // any other third-party data connector (a scraping vendor, say) — can only
      // ever refuse until the workspace connects it, and being vendor-hidden it
      // cannot even say which vendor to connect. Those are ordinary
      // bind-and-redistill connectors: connect on the connections page, bind,
      // redistill, use their tools directly. OWN-ACCOUNT connectors are the
      // explicit exception: a tenant's OWN connected systems (gmail, slack) are
      // reached with the tenant's own credential and stay discoverable as
      // own_account capabilities. (apify is platform-provided but arrives via the
      // apify-store source, not this connector-registry walk.)
      // Connect/bind/redistill-only vendors are never discovery-surfaced, in
      // EITHER mode. The public_data guard below misses saperly: its catalog
      // category is `social_messaging`, so connectorMode returns `own_account`
      // and it slips through as saperly:send_sms / saperly:place_call. These are
      // identity-bound BYO vendors (US A2P 10DLC registration is the tenant's, no
      // platform account to fall back to) that a workspace reaches only after an
      // explicit connect + bind, not through vendor-hidden discovery.
      if (BYO_ONLY_VENDORS.has(connectorType)) continue;
      if (mode === 'public_data' && !PLATFORM_EXECUTABLE_VENDORS.has(connectorType)) continue;
      // The operator's switch (vendor-gate.ts): a vendor whose account cannot
      // pay is not offered, so the model never picks a capability that can
      // only fail. The executor refuses it too, for a handle minted earlier.
      if (off.has(connectorType)) continue;
      const connectorBucket = classifyConnectorToBucket(connectorType, def.category as string | undefined) ?? undefined;
      const objects = (def.objectsCovered ?? []).join(' ');
      const caps = (def.capabilities ?? [])
        .map((c) => (typeof c === 'string' ? c : c?.capability ?? ''))
        .join(' ');
      const connectorStrong = `${connectorType} ${def.displayName ?? ''}`;
      const connectorWeak = `${def.description ?? ''} ${objects} ${caps} ${def.category ?? ''}`;
      const fns = meta?.functionNames ?? [];

      if (fns.length > 0) {
        // Function-level: keep this connector's most-relevant few functions,
        // FEW PER BUCKET rather than few per connector.
        //
        // The cut has to be per bucket because a connector is not a domain. An
        // aggregator card resells people search, SEO, crypto, market data and
        // web reads behind one type — `locus` carries ~295 functions — so a
        // top-N over the connector returns N neighbours of whichever domain
        // scored highest and every other domain the card serves is
        // unreachable, however well it matches the need. That is invisible
        // from the outside: the capability is registered, priced, classified
        // and dispatchable, and simply never becomes a candidate. Per bucket,
        // each domain the card covers keeps its own few.
        //
        // The total is still bounded by MAX_CANDIDATES_PER_SOURCE below, so
        // this widens what can be SEEN without widening what the judge reads.
        const scored = fns
          .map((fn) => ({
            fn,
            rel: relevanceOf(terms, `${connectorStrong} ${fn}`, connectorWeak),
            // The function's own name first, the card's bucket only where the
            // name says nothing: a multi-domain card has no true bucket.
            bucket: functionBucket(fn) ?? connectorBucket,
          }))
          .filter((x) => x.rel > 0)
          .sort((a, b) => b.rel - a.rel);
        const keptPerBucket = new Map<string, number>();
        for (const { fn, rel, bucket } of scored) {
          const kept = keptPerBucket.get(bucket ?? '') ?? 0;
          if (kept >= FUNCTIONS_PER_BUCKET) continue;
          keptPerBucket.set(bucket ?? '', kept + 1);
          const usd = meta?.functionPrices?.[fn];
          out.push({
            source: 'connector_registry',
            sourceRef: `${connectorType}:${fn}`,
            title: `${def.displayName ?? connectorType} — ${fn}`,
            description: def.description ?? '',
            mode,
            connectorType,
            capabilityBucket: bucket,
            relevance: bucket && bucket === queryBucket ? rel * IN_BUCKET_BOOST : rel,
            // The platform's listed price for the call; absent for a BYO
            // card, whose charge is the workspace's own.
            ...(typeof usd === 'number' && Number.isFinite(usd) ? { price: { type: 'PER_CALL' as const, usd } } : {}),
          });
        }
      } else {
        // Connector-level: Composio-managed etc. surface on metadata alone.
        const rel = relevanceOf(terms, connectorStrong, connectorWeak);
        if (rel > 0) {
          out.push({
            source: 'connector_registry',
            sourceRef: connectorType,
            title: def.displayName ?? connectorType,
            description: def.description ?? '',
            mode,
            connectorType,
            capabilityBucket: connectorBucket,
            relevance: connectorBucket && connectorBucket === queryBucket ? rel * IN_BUCKET_BOOST : rel,
          });
        }
      }
    }
    out.sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
    return out.slice(0, MAX_CANDIDATES_PER_SOURCE);
  } catch (error) {
    log.warn({ error }, 'capability-discovery: connector registry search failed');
    return [];
  }
}

/** The platform-native web tools every agent already has. Static and local;
 *  they carry mode public_data (they read the public web). */
export function nativeToolCandidates(spec: CapabilitySpec): Candidate[] {
  if (spec.mode !== 'public_data') return [];
  const terms = specTerms(spec);
  return PLATFORM_WEB_TOOLS.map((t) => ({
    source: 'native_tool' as const,
    sourceRef: t.name,
    title: t.name,
    description: t.description,
    mode: 'public_data' as const,
    relevance: relevanceOf(terms, t.name, t.description),
  }));
}
