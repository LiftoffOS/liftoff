// Replays one historical retrieval against an alternate ranker config.
//
// Uses the same memoryService.retrieveMemories code path as production
// — passing a RankingWeights override via process.env.MEM_WEIGHT_*
// (resolved on the first scoreMemory call after __resetEnvWeightsCacheForTests).
// Per-call override threading would require touching the production
// service for an offline-only flag, which we deliberately avoid.
//
// Each candidate ranker mutates env, resets the cache, invokes
// retrieveMemories, then restores env. Sequential — no parallelism in
// the same process because env is process-global.

import { memoryService } from '../../memory/service';
import {
  RankingWeights,
  DEFAULT_WEIGHTS,
  __resetEnvWeightsCacheForTests,
} from '../../memory/ranking-config';
import type { EvalEvent } from './dataset';

const WEIGHT_ENV_KEYS: Record<keyof RankingWeights, string> = {
  wTag:          'MEM_WEIGHT_TAG',
  wSemantic:     'MEM_WEIGHT_SEMANTIC',
  wRecency:      'MEM_WEIGHT_RECENCY',
  wType:         'MEM_WEIGHT_TYPE',
  wFeedback:     'MEM_WEIGHT_FEEDBACK',
  wInfluence:    'MEM_WEIGHT_INFLUENCE',
  wSummary:      'MEM_WEIGHT_SUMMARY',
  wSourceTrust:  'MEM_WEIGHT_SOURCE_TRUST',
  recencyDecay:  'MEM_RECENCY_DECAY',
  minSimilarity: 'MEM_MIN_SIMILARITY',
};

function applyWeightsEnv(weights: RankingWeights): Map<string, string | undefined> {
  const original = new Map<string, string | undefined>();
  for (const [field, envKey] of Object.entries(WEIGHT_ENV_KEYS) as [keyof RankingWeights, string][]) {
    original.set(envKey, process.env[envKey]);
    process.env[envKey] = String(weights[field]);
  }
  __resetEnvWeightsCacheForTests();
  return original;
}

function restoreEnv(original: Map<string, string | undefined>): void {
  for (const [envKey, value] of original) {
    if (value === undefined) delete process.env[envKey];
    else process.env[envKey] = value;
  }
  __resetEnvWeightsCacheForTests();
}

export async function replay(
  event: EvalEvent,
  weights: RankingWeights = DEFAULT_WEIGHTS,
  topK = 20,
): Promise<string[]> {
  const original = applyWeightsEnv(weights);
  try {
    const memories = await memoryService.retrieveMemories({
      tenantId: event.tenantId,
      query: event.query,
      agentId: event.agentId ?? undefined,
      threadId: event.threadId ?? undefined,
      topK,
    });
    return memories.map(m => m.id);
  } finally {
    restoreEnv(original);
  }
}
