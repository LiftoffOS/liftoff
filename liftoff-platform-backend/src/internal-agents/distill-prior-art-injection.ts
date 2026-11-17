// The "PRIOR ART" section of the distillation prompt.
//
// The distiller authors an agent's workflow knowing what the user typed and
// which systems are bound, and nothing about how proven automations in this
// domain actually do the job. Given prior art — the best-fitting building
// blocks the capability-discovery service found, with our own judge's reasons
// and any absorbed blueprint procedure — it can author against evidence
// instead of guessing from the role text alone.
//
// THIRD-PARTY CONTENT, UNLIKE THE LANDSCAPE. The landscape section is counts
// from our own database and is deliberately unfenced. Candidate titles and
// descriptions here derive from external catalogs, so the caller MUST wrap
// the body this module returns in the user-content nonce fence before it
// enters the prompt. The builder stays pure and returns body text only; the
// advisory header (our own words) is exported separately and belongs OUTSIDE
// the fence.
//
// Suppress-when-empty: an empty result set returns '' rather than "no prior
// art exists" — discovery may simply have timed out, and telling the
// distiller a domain has no prior art would have it write around an absence
// that is an artifact of our own deadline.

import { createHash } from 'crypto';
import type { CapabilityMode, CapabilitySpec, DiscoveryResult, ScoredCandidate } from '../capability-discovery';
import { apifyPlatformConfigured } from '../capability-discovery/apify-executor';
import { llmClient } from '../llm/client';
import { log } from '../infrastructure/logging';

/** Target systems worth naming in a spec — the demand-weighted head of the
 *  ecosystem (most of the top store actors target these). */
const TARGET_SYSTEMS = [
  'linkedin', 'instagram', 'tiktok', 'facebook', 'youtube', 'twitter',
  'reddit', 'zillow', 'amazon', 'telegram', 'indeed', 'threads', 'yelp',
  'tripadvisor', 'airbnb', 'crunchbase', 'similarweb', 'ebay', 'trustpilot',
  'g2', 'upwork', 'glassdoor', 'booking', 'walmart', 'etsy', 'pinterest',
  'twitch', 'spotify', 'medium', 'substack', 'snapchat', 'realtor', 'redfin',
  'capterra', 'wellfound', 'douyin', 'weibo', 'bilibili', 'xiaohongshu',
] as const;

/** Cue words that mark an intent as PUBLIC third-party data rather than the
 *  user's own account. The axis matters more than the platform name: an
 *  official Instagram connector serves YOUR account; "competitor Instagram"
 *  needs the public web. */
// Cues must be SPECIFIC to public third-party data. Bare ambiguous words were
// the false-positive source: 'market' fired on 'marketing', 'lead'/'leads' on
// "program leads"/"launch leads", 'public' on "public holiday", 'research' on
// any internal analysis. Each is replaced by the phrase that actually signals
// public-data intent, so own-account work (a PMM coordinating launches) no
// longer trips them.
const PUBLIC_DATA_CUES = [
  'competitor', 'competitors', 'competitive', 'rival', 'rivals',
  'lead generation', 'generate leads', 'sales lead', 'sales leads',
  'prospect', 'prospects', 'prospecting',
  'market research', 'market intelligence', 'social listening',
  'scrape', 'scraping', 'web scraping',
  'trending', 'viral', 'influencer', 'influencers', 'listings',
  'reputation', 'public reviews', 'public web', 'publicly available',
];

const OWN_ACCOUNT_CUES = ['our ', 'my ', 'inbox', 'workspace', 'team’s', "team's"];

interface OperationPattern {
  verbs: string[];
  operation: string;
  entity: string;
  outputFields: string[];
}

const OPERATION_PATTERNS: OperationPattern[] = [
  { verbs: ['monitor', 'track', 'watch', 'alert'], operation: 'monitor', entity: 'posts', outputFields: ['url', 'author', 'text', 'timestamp'] },
  { verbs: ['enrich', 'verify', 'validate'], operation: 'enrich', entity: 'profiles', outputFields: ['name', 'email', 'company'] },
  { verbs: ['find', 'search', 'source', 'collect', 'gather', 'generate leads'], operation: 'search', entity: 'profiles', outputFields: ['name', 'url'] },
  { verbs: ['scrape', 'extract', 'pull'], operation: 'extract', entity: 'listings', outputFields: ['title', 'url', 'price'] },
];

/** The concrete thing an agent tracks, extracted from the text — so a
 *  competitive-intelligence agent gets a spec about competitor activity, not
 *  the operation pattern's generic default entity. First match wins; falls back
 *  to the pattern's entity when nothing matches. */
const ENTITY_CUES: Array<{ words: string[]; entity: string }> = [
  { words: ['review', 'reviews', 'rating', 'ratings'], entity: 'reviews' },
  { words: ['job', 'jobs', 'hiring', 'vacancy', 'vacancies', 'candidate', 'candidates'], entity: 'job postings' },
  { words: ['listing', 'listings', 'property', 'properties'], entity: 'listings' },
  { words: ['price', 'prices', 'pricing'], entity: 'prices' },
  { words: ['news', 'headline', 'headlines', 'article', 'articles'], entity: 'news' },
  { words: ['mention', 'mentions', 'sentiment', 'reputation'], entity: 'mentions' },
  { words: ['competitor', 'competitors', 'competitive', 'rival', 'rivals'], entity: 'competitor activity' },
  { words: ['company', 'companies', 'firm', 'firms', 'business', 'businesses', 'startup', 'startups'], entity: 'companies' },
  { words: ['profile', 'profiles', 'people', 'person', 'contact', 'contacts'], entity: 'profiles' },
  { words: ['video', 'videos', 'reel', 'reels'], entity: 'videos' },
  { words: ['post', 'posts', 'content', 'engagement'], entity: 'posts' },
];

/** Word-boundary match, so a cue never fires on a substring — 'market' must
 *  not match 'marketing' (which mis-flagged own-account PMM work as public
 *  data). Multi-word or punctuated cues ('generate leads', "team's") fall back
 *  to substring, since a word-boundary regex over a phrase is fragile. */
function hasWord(text: string, term: string): boolean {
  if (/[^a-z0-9]/.test(term)) return text.includes(term);
  return new RegExp(`\\b${term}\\b`).test(text);
}

/** Heuristic decomposition of role + responsibilities into at most three
 *  capability specs. Deliberately coarse: retrieval only needs the target
 *  system and verb; the judge scores candidates against the finer fields. */
export function deriveCapabilitySpecs(
  role: string,
  responsibilities: string,
  integrationTypes: string[],
  tenantId: string,
): CapabilitySpec[] {
  const text = `${role}\n${responsibilities}`.toLowerCase();

  const publicHits = PUBLIC_DATA_CUES.filter((c) => hasWord(text, c)).length;
  const ownHits = OWN_ACCOUNT_CUES.filter((c) => hasWord(text, c)).length;
  const mode: CapabilityMode = publicHits > ownHits ? 'public_data' : 'own_account';
  // Prior art only exists for the public-data side: own-account work is
  // already fully described by the bound connectors' own tool catalogs.
  if (mode !== 'public_data') return [];

  const systems = TARGET_SYSTEMS.filter((s) => hasWord(text, s)).slice(0, 3);
  const pattern =
    OPERATION_PATTERNS.find((p) => p.verbs.some((v) => hasWord(text, v))) ??
    OPERATION_PATTERNS[2];
  // Entity comes from what the text actually names, not the pattern's default,
  // so retrieval searches for the right thing (competitor activity, reviews,
  // job postings) instead of always 'posts'.
  const entity = ENTITY_CUES.find((e) => e.words.some((w) => hasWord(text, w)))?.entity ?? pattern.entity;

  const base: Omit<CapabilitySpec, 'targetSystem'> = {
    operation: pattern.operation,
    entity,
    mode: 'public_data',
    availableInputs: ['search_terms'],
    requiredOutputFields: pattern.outputFields,
    tenantId,
    boundConnectorTypes: integrationTypes,
  };
  if (systems.length === 0) return [{ ...base }];
  return systems.map((targetSystem) => ({ ...base, targetSystem }));
}

/** Invalidation key for the cached LLM specs. The cache is authoritative only
 *  while this matches the current role/responsibilities/integrations; any edit
 *  changes the hash, so the prefetch falls back to the heuristic until a fresh
 *  derivation lands. Integrations are order-normalized so a reorder is a no-op. */
export function capabilitySpecsSourceHash(
  role: string,
  responsibilities: string,
  integrationTypes: string[],
): string {
  return createHash('sha256')
    .update(`${role} ${responsibilities} ${[...integrationTypes].sort().join(',')}`)
    .digest('hex');
}

function cleanStrings(v: unknown, fallback: string[]): string[] {
  if (!Array.isArray(v)) return fallback;
  const out = v
    .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
    .map((x) => x.trim().slice(0, 120))
    .slice(0, 20);
  return out.length > 0 ? out : fallback;
}

const SPEC_EXTRACTOR_SYSTEM_PROMPT =
  "You read an AI worker's role and responsibilities and extract the PUBLIC third-party " +
  'data-gathering capabilities it will need — information it must pull from OUTSIDE systems ' +
  '(social platforms, the open web, market/financial data, reviews, listings, public records). ' +
  "Do NOT list actions on the workspace's own connected accounts (sending email, updating a CRM, " +
  'posting) — those are covered by the bound connectors. If the role is purely own-account work, ' +
  'return an empty list.\n' +
  'For each distinct public-data need, emit one spec:\n' +
  '- operation: the verb — e.g. "monitor", "search", "enrich", "look up", "extract".\n' +
  '- entity: what is fetched — e.g. "news headlines", "job postings", "company reviews", "stock quote".\n' +
  '- targetSystem: the specific platform when the role names or clearly implies one ' +
  '(e.g. "tiktok", "linkedin", "zillow"); omit when generic.\n' +
  '- availableInputs: the inputs the worker will have — e.g. ["company"], ["ticker"], ["search_terms"].\n' +
  '- requiredOutputFields: the fields the answer must contain — e.g. ["headline","url"], ["price"].\n' +
  'Return at most 6 specs, the most central first.';

/** The LLM counterpart to deriveCapabilitySpecs: it READS the role text instead
 *  of keyword-matching it, so it catches intents phrased in ways the cue lists
 *  miss and names the entity and target system precisely. It is NOT for the
 *  distillation hot path (an LLM call would blow the summary-wave budget) — it
 *  runs at authoring and its result is cached on the agent, keyed by
 *  capabilitySpecsSourceHash. On any failure it falls back to the heuristic, so
 *  it is never worse than the keyword path. An empty result is a real answer
 *  (own-account role), returned as-is; only an error falls back. */
export async function deriveCapabilitySpecsLLM(
  role: string,
  responsibilities: string,
  integrationTypes: string[],
  tenantId: string,
): Promise<CapabilitySpec[]> {
  try {
    const response = await llmClient.complete(
      {
        messages: [
          { role: 'system', content: SPEC_EXTRACTOR_SYSTEM_PROMPT },
          { role: 'user', content: `ROLE:\n${role}\n\nRESPONSIBILITIES:\n${responsibilities}` },
        ],
        temperature: 0.1,
        responseSchema: {
          name: 'capability_specs',
          schema: {
            type: 'object',
            properties: {
              specs: {
                type: 'array',
                items: {
                  type: 'object',
                  properties: {
                    operation: { type: 'string' },
                    entity: { type: 'string' },
                    targetSystem: { type: 'string' },
                    availableInputs: { type: 'array', items: { type: 'string' } },
                    requiredOutputFields: { type: 'array', items: { type: 'string' } },
                  },
                  required: ['operation', 'entity'],
                },
              },
            },
            required: ['specs'],
          },
        },
      },
      undefined,
      { tenantId, purpose: 'capability_spec_extraction' },
    );
    const parsed = JSON.parse(response.content) as { specs?: Array<Record<string, unknown>> };
    const raw = Array.isArray(parsed.specs) ? parsed.specs.slice(0, 6) : [];
    return raw
      .filter((s) => s && typeof s.operation === 'string' && typeof s.entity === 'string')
      .map((s) => ({
        operation: String(s.operation).slice(0, 120),
        entity: String(s.entity).slice(0, 120),
        mode: 'public_data' as CapabilityMode,
        availableInputs: cleanStrings(s.availableInputs, ['search_terms']),
        requiredOutputFields: cleanStrings(s.requiredOutputFields, []),
        tenantId,
        boundConnectorTypes: integrationTypes,
        ...(typeof s.targetSystem === 'string' && s.targetSystem.trim()
          ? { targetSystem: s.targetSystem.trim().toLowerCase().slice(0, 64) }
          : {}),
      }));
  } catch (error) {
    log.warn({ error, tenantId }, 'capability spec LLM extraction failed; using keyword heuristic');
    return deriveCapabilitySpecs(role, responsibilities, integrationTypes, tenantId);
  }
}

/** The one case a web search is mistaken for cover. Records that live on a
 *  named platform — posts on a forum, profiles on a network, listings on a
 *  marketplace — come back from a search as pages ABOUT the platform, not as
 *  its records: a team asked for ten posts got the platform's own help forum
 *  and review sites. Stated once and carried into every place the distiller
 *  is told when a capability step is the right step. */
export const PLATFORM_RECORDS_ARE_A_CAPABILITY_NEED =
  'A web search does NOT cover records that live on a named platform — posts on a forum, ' +
  'profiles on a network, listings on a marketplace: search returns pages about the platform, ' +
  'not its records. Pulling those is a capability need, and the step is type=capability.';

/** Our own words, rendered OUTSIDE the fence. */
export const PRIOR_ART_HEADER =
  'PRIOR ART. Proven building blocks for this kind of work, found and ranked by the ' +
  'platform. ADVISORY ONLY: use them to decide what the workflow must handle. Where a ' +
  'bound tool from AVAILABLE TOOLS covers a step, name it exactly. Where the step needs ' +
  'public-web / third-party data or an outbound action that NO bound tool and NO platform ' +
  'tool covers — which is what the items below are — author a type=capability step that ' +
  'describes the NEED (operation, entity, mode), and the runtime finds and runs the best ' +
  'provider at run time. ' + PLATFORM_RECORDS_ARE_A_CAPABILITY_NEED + ' The names below ' +
  'identify capabilities: NEVER copy a provider or product name into a step, a description, ' +
  'or the instructions. Use type=llm_reason only for pure judgment over earlier output.';

/** How many candidates per capability make it into the prompt. One walker
 *  below renders them AND reports them, so the consumption record can never
 *  disagree with what the model was actually shown. */
const RENDERED_PER_CAPABILITY = 3;

/** A store actor the platform account can run is a capability the runtime
 *  resolves and runs at a capability step, the same way the assistant runs
 *  it. Its compiled procedure describes what the actor does INSIDE, and read
 *  as prior art it invites the distiller to re-implement those stages with
 *  the tools it has — a web search standing in for a feed pull, which is the
 *  one substitution the platform-records rule forbids. So a runnable actor is
 *  rendered as the capability it is, without the procedure; the procedure is
 *  shown only when nothing can run the actor and replicating it is the only
 *  way the work gets done. */
function runnableStoreActor(c: ScoredCandidate): boolean {
  return c.route === 'blueprint' && c.source === 'apify_store' && apifyPlatformConfigured();
}

function walkRendered(
  results: DiscoveryResult[] | null,
): { lines: string[]; refs: Array<{ source: string; sourceRef: string }> } {
  const lines: string[] = [];
  const refs: Array<{ source: string; sourceRef: string }> = [];
  for (const r of results ?? []) {
    const top = r.candidates.slice(0, RENDERED_PER_CAPABILITY);
    if (top.length === 0) continue;
    const need = [r.spec.targetSystem, r.spec.operation, r.spec.entity]
      .filter(Boolean)
      .join(' ');
    lines.push(`For "${need}":`);
    for (const c of top) {
      refs.push({ source: c.source, sourceRef: c.sourceRef });
      if (runnableStoreActor(c)) {
        lines.push(`  - [capability] ${c.title}: ${c.judge.reason} (runs at a type=capability step)`);
        continue;
      }
      lines.push(`  - [${c.route}] ${c.title}: ${c.judge.reason}`);
      if (c.blueprintProcedureMd) {
        lines.push(
          ...c.blueprintProcedureMd
            .split('\n')
            .slice(0, 30)
            .map((l) => `      ${l}`),
        );
      }
    }
  }
  return { lines, refs };
}

/** Body text for the fenced section. Returns '' when there is nothing worth
 *  saying from ANY result — the caller concatenates unconditionally. */
export function buildPriorArtSection(results: DiscoveryResult[] | null): string {
  const { lines } = walkRendered(results);
  return lines.length === 0 ? '' : lines.join('\n');
}

/** The refs the section actually shows — the consumption record's source of
 *  truth, from the SAME walk that renders. */
export function priorArtRenderedRefs(
  results: DiscoveryResult[] | null,
): Array<{ source: string; sourceRef: string }> {
  return walkRendered(results).refs;
}
