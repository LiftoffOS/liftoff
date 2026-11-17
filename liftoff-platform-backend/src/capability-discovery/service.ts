// Capability discovery — orchestration.
//
// discoverCapabilities() is the ONE entry point (distill prep, the Liftoff
// assistant, and — over the internal HTTP route — the CAIO). It runs the
// retrieve → judge stage under a total deadline with a cache in front, then
// always re-scores fresh (route preference and evidence are per-caller).
//
// The structured log line emitted per query IS the roadmap signal: weak-fit
// queries are real user demand the surface could not serve, ranked by our own
// market rather than anyone's catalog census. There are no census jobs.

import { log } from '../infrastructure/logging';
import { analyzeAdoptedRef } from './blueprint-analyzer';
import { getCached, setCached } from './cache';
import { DEFAULT_BUDGET_MS, MAX_JUDGE_CANDIDATES, WEAK_FIT_THRESHOLD } from './config';
import { getBlueprintsForCandidates, getEvidenceForCandidates } from './evidence';
import { judgeCandidates } from './judge';
import { scoreCandidates } from './scorer';
import { nativeToolCandidates, searchApifyStore, searchConnectorRegistry } from './sources';
import { switchedOffVendors } from './vendor-gate';
import type { Candidate, CapabilitySpec, DiscoveryResult, JudgeVerdict } from './types';

function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    p.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      },
    );
  });
}

export interface DiscoverOptions {
  budgetMs?: number;
  /** Whether the credential THIS caller would run a vendor on is parked right
   *  now (vendor-gate.ts). Supplied by a search that resolved the caller's
   *  credentials; absent for the distiller's prior art, which is never
   *  narrowed by a cooldown — needs are vendor-agnostic and the step resolves
   *  live at run time, so a team authored during a five-minute outage must
   *  still get its capability step. */
  vendorCooling?: (connectorType: string) => boolean;
}

/** The connector type a candidate would run on, for the two per-vendor
 *  filters. A store actor runs on the platform Apify account; a native tool
 *  runs on nothing that can be switched off or parked. */
function vendorOf(c: Candidate): string | null {
  if (c.source === 'apify_store') return 'apify';
  if (c.source === 'connector_registry') return c.connectorType ?? null;
  return null;
}

/** The judged pool with every candidate whose vendor is unusable for this
 *  caller removed — switched off by the operator, or parked on the credential
 *  the caller would run it on — TOGETHER with its verdict, so the two arrays
 *  stay aligned by index for the scorer. Applied to the whole cached pool of
 *  MAX_JUDGE_CANDIDATES before the cut to MAX_RESULTS, which is what lets a
 *  healthy sixth candidate take a parked vendor's place; a filter after the
 *  cut could only shorten the list. The cache entry is left as it was: the
 *  pool is per query, the filter is per caller and per moment. */
export function filterUnusableCandidates(
  candidates: Candidate[],
  verdicts: JudgeVerdict[],
  off: ReadonlySet<string>,
  vendorCooling: ((connectorType: string) => boolean) | undefined,
): { candidates: Candidate[]; verdicts: JudgeVerdict[]; removed: number } {
  const keptCandidates: Candidate[] = [];
  const keptVerdicts: JudgeVerdict[] = [];
  candidates.forEach((c, i) => {
    const vendor = vendorOf(c);
    if (vendor && (off.has(vendor) || (vendorCooling?.(vendor) ?? false))) return;
    keptCandidates.push(c);
    keptVerdicts.push(verdicts[i]);
  });
  return { candidates: keptCandidates, verdicts: keptVerdicts, removed: candidates.length - keptCandidates.length };
}

export async function discoverCapabilities(
  spec: CapabilitySpec,
  opts: DiscoverOptions = {},
): Promise<DiscoveryResult> {
  const budgetMs = opts.budgetMs ?? DEFAULT_BUDGET_MS;
  const started = Date.now();
  // The operator's vendor switch is read here, once per discovery, so the
  // synchronous readers downstream (apifyPlatformConfigured in the renderers
  // and the distiller's prior art) see a fresh answer even when the candidate
  // set itself comes from the cache and no source is walked. The same read
  // loads the live cooldowns for `opts.vendorCooling`.
  const off = await switchedOffVendors();

  let candidates: Candidate[];
  let verdicts: JudgeVerdict[];
  let degraded = false;

  const cached = getCached(spec);
  if (cached) {
    candidates = cached.candidates;
    verdicts = cached.verdicts;
  } else {
    // Retrieval fans out with the budget shared; a slow source yields an
    // incomplete list, never a slow answer.
    const retrievalBudget = Math.min(budgetMs * 0.5, budgetMs - 500);
    const [store, registry] = await Promise.all([
      withDeadline(searchApifyStore(spec, { timeoutMs: retrievalBudget }), retrievalBudget, null),
      withDeadline(searchConnectorRegistry(spec), retrievalBudget, null),
    ]);
    if (store === null || registry === null) degraded = true;
    const gathered = [...(registry ?? []), ...nativeToolCandidates(spec), ...(store ?? [])];
    // Stage 2 — pre-rank by cheap query relevance and TRUNCATE before the
    // judge. The judge's cost is then a function of a fixed K, not of how many
    // candidates retrieval happened to return, so a large set can no longer
    // starve it into all-neutral verdicts.
    gathered.sort((a, b) => (b.relevance ?? 0) - (a.relevance ?? 0));
    candidates = gathered.slice(0, MAX_JUDGE_CANDIDATES);

    // On judge timeout, candidates pass through with the same neutral
    // verdicts the judge's own failure path uses — an un-judged ranking beats
    // an empty one, and `degraded` marks it either way.
    const neutralOutcome = {
      verdicts: candidates.map<JudgeVerdict>(() => ({
        capabilityMatch: 1,
        inputSupplyable: 'partial',
        outputCovers: 'partial',
        shapeMatch: true,
        reason: 'judge deadline exceeded; neutral verdict',
      })),
      degraded: true,
    };
    const judgeBudget = budgetMs - (Date.now() - started) - 100;
    const outcome =
      judgeBudget < 300
        ? neutralOutcome
        : await withDeadline(judgeCandidates(spec, candidates), judgeBudget, neutralOutcome);
    degraded = degraded || outcome.degraded;
    verdicts = outcome.verdicts;
    if (!degraded && candidates.length > 0) {
      setCached(spec, { candidates, verdicts });
    }
  }

  // The per-caller, per-moment cut: a vendor the operator switched off, or
  // whose credential this caller would run on is parked, leaves the pool
  // here — after the cache, so the entry keeps the whole judged pool for the
  // next caller, and before the scorer's cut to MAX_RESULTS, so the offered
  // five come from healthy candidates. Verdicts travel with their candidates.
  const usable = filterUnusableCandidates(candidates, verdicts, off, opts.vendorCooling);
  candidates = usable.candidates;
  verdicts = usable.verdicts;

  // Scoring is always fresh: evidence and route preference are per-caller.
  const [evidence, blueprints] = await Promise.all([
    getEvidenceForCandidates(candidates),
    getBlueprintsForCandidates(candidates),
  ]);
  const ranked = scoreCandidates({
    spec,
    candidates,
    verdicts,
    evidence,
    blueprints,
  });

  // Adoption is what triggers deep research — a ranked blueprint-route
  // candidate without a compiled blueprint gets one, offline, fire-and-forget.
  // Never a sweep: only refs a real query surfaced.
  for (const c of ranked) {
    if (c.route === 'blueprint' && !c.blueprintProcedureMd) {
      void analyzeAdoptedRef({
        source: c.source,
        sourceRef: c.sourceRef,
        title: c.title,
        description: c.description,
      });
    }
  }

  const topScore = ranked[0]?.finalScore ?? 0;
  // Who was offered and who was judged out, by ref: a vendor missing from a
  // pool is otherwise invisible behind the counts. Bounded to the judged pool.
  const rankedRefs = ranked.map((c) => c.sourceRef);
  const judgedOut = candidates
    .map((c, i) => ({ ref: c.sourceRef, match: verdicts[i]?.capabilityMatch ?? null }))
    .filter((c) => !rankedRefs.includes(c.ref))
    .slice(0, MAX_JUDGE_CANDIDATES);
  log.info(
    {
      metric: 'capability_discovery.query',
      targetSystem: spec.targetSystem ?? null,
      mode: spec.mode,
      candidateCount: candidates.length,
      unusableRemoved: usable.removed,
      resultCount: ranked.length,
      topScore,
      chosenRoute: ranked[0]?.route ?? null,
      rankedRefs,
      judgedOut,
      degraded,
      weakFit: topScore < WEAK_FIT_THRESHOLD,
      elapsedMs: Date.now() - started,
    },
    'capability discovery query',
  );

  return { spec, candidates: ranked, degraded };
}
