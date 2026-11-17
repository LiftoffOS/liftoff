// Memory ranking — fusion weight config.
//
// One canonical home for the fusion formula AND its weights. Lifted out
// of service.ts so the offline eval harness (src/scripts/memory-eval/)
// can pass alternate RankingWeights to scoreMemory without mutating
// process.env. Env-var overrides remain wired so the deploy path
// doesn't change.

/**
 * Composite score for a candidate memory:
 *
 *   compositeScore =
 *       wTag       × tagScore(memoryTags, contextTags)              // [0,1]
 *     + wSemantic  × similarity                                     // cosine [0,1]
 *     + wRecency   × 1 / (1 + ageDays × recencyDecay)               // [0,1]
 *     + wType      × max(TYPE_SCORES[t] for t in memoryTags)        // [0,1]
 *     + wFeedback  × rawFeedback × clamp01(sourceTrust) × wSourceTrust
 *     + wInfluence × influenceScore                                 // additive boost
 *     + wSummary   × (summaryLevel > 0 ? 1 : 0)                     // additive boost
 *
 * Where:
 *   rawFeedback = 0.7 × normalize(usefulness, [-10, 100], [0, 1])
 *               + 0.3 × normalize(importance, [1, 5], [0, 1])
 *
 * Weights are NOT required to sum to 1.0 — additive boosts (influence,
 * summary) sit on top of the weighted sum. recencyDecay = 0.02 means a
 * ~50-day-old memory scores 0.5 recency.
 *
 * minSimilarity prefilters vector-sourced hits (cosine < threshold gets
 * dropped). BM25-sourced rows have similarity = 0 by construction (see
 * runMemoriesBM25Query in service.ts) — they bypass the threshold and
 * land in the candidate set unconditionally, which is intentional.
 */
export interface RankingWeights {
  wTag: number;
  wSemantic: number;
  wRecency: number;
  wType: number;
  wFeedback: number;
  wInfluence: number;
  wSummary: number;
  /** Multiplier inside the feedback term — NOT an additive weight. */
  wSourceTrust: number;
  recencyDecay: number;
  minSimilarity: number;
}

export const DEFAULT_WEIGHTS: Readonly<RankingWeights> = Object.freeze({
  wTag:          0.35,
  wSemantic:     0.30,
  wRecency:      0.20,
  wType:         0.10,
  wFeedback:     0.05,
  wInfluence:    0.0,   // Change B (D8): ships at 0; step to 0.05/0.10 per activation table.
  wSummary:      0.05,  // Change C (D18).
  wSourceTrust:  1.0,   // Change D — multiplier on the feedback term.
  recencyDecay:  0.02,
  minSimilarity: 0.4,
});

/** Type scores: normalized [0, 1] priority by memory type tag. */
export const TYPE_SCORES: Readonly<Record<string, number>> = Object.freeze({
  'type:gotcha':           1.0,
  'type:decision':         1.0,
  'type:alias':            1.0,
  'type:preference':       0.67,
  'type:error-resolution': 0.67,
  'type:convention':       0.67,
  'type:context':          0.33,
});

let envWeightsCache: RankingWeights | null = null;

/** Reads MEM_WEIGHT_* / MEM_RECENCY_DECAY / MEM_MIN_SIMILARITY env vars
 *  on first call. Same env var names as the pre-PR-7 module-level
 *  constants — env-validator.ts:13-22 still validates ranges at boot. */
export function resolveEnvWeights(env: NodeJS.ProcessEnv = process.env): RankingWeights {
  if (envWeightsCache) return envWeightsCache;
  const num = (key: string, fallback: number): number => {
    const raw = env[key];
    if (raw === undefined || raw === '') return fallback;
    const n = parseFloat(raw);
    return Number.isFinite(n) ? n : fallback;
  };
  envWeightsCache = {
    wTag:          num('MEM_WEIGHT_TAG',          DEFAULT_WEIGHTS.wTag),
    wSemantic:     num('MEM_WEIGHT_SEMANTIC',     DEFAULT_WEIGHTS.wSemantic),
    wRecency:      num('MEM_WEIGHT_RECENCY',      DEFAULT_WEIGHTS.wRecency),
    wType:         num('MEM_WEIGHT_TYPE',         DEFAULT_WEIGHTS.wType),
    wFeedback:     num('MEM_WEIGHT_FEEDBACK',     DEFAULT_WEIGHTS.wFeedback),
    wInfluence:    num('MEM_WEIGHT_INFLUENCE',    DEFAULT_WEIGHTS.wInfluence),
    wSummary:      num('MEM_WEIGHT_SUMMARY',      DEFAULT_WEIGHTS.wSummary),
    wSourceTrust:  num('MEM_WEIGHT_SOURCE_TRUST', DEFAULT_WEIGHTS.wSourceTrust),
    recencyDecay:  num('MEM_RECENCY_DECAY',       DEFAULT_WEIGHTS.recencyDecay),
    minSimilarity: num('MEM_MIN_SIMILARITY',      DEFAULT_WEIGHTS.minSimilarity),
  };
  return envWeightsCache;
}

/** Test-only reset hook. Importing tests that mutate process.env
 *  between cases call this to bust the per-process cache. */
export function __resetEnvWeightsCacheForTests(): void {
  envWeightsCache = null;
}
