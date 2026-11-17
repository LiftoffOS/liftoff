// Registry of ranker configurations to compare in the eval harness.
// Add new entries here when sweeping a weight knob; the harness exposes
// them via the --candidates CLI flag.

import { DEFAULT_WEIGHTS, RankingWeights } from '../../memory/ranking-config';
import type { EvalEvent } from './dataset';
import { replay } from './replay';

export interface RankerCandidate {
  name: string;
  weights: RankingWeights;
  retrieve: (event: EvalEvent) => Promise<string[]>;
}

function makeCandidate(name: string, weights: RankingWeights): RankerCandidate {
  return { name, weights, retrieve: (e) => replay(e, weights) };
}

export const CANDIDATES: RankerCandidate[] = [
  makeCandidate('baseline', DEFAULT_WEIGHTS),
  makeCandidate('no-recency',          { ...DEFAULT_WEIGHTS, wRecency: 0 }),
  makeCandidate('no-influence-summary',{ ...DEFAULT_WEIGHTS, wInfluence: 0, wSummary: 0 }),
  makeCandidate('high-semantic',       { ...DEFAULT_WEIGHTS, wSemantic: 0.55, wTag: 0.15 }),
  makeCandidate('high-influence-0.10', { ...DEFAULT_WEIGHTS, wInfluence: 0.10 }),
];

export function candidateByName(name: string): RankerCandidate {
  const c = CANDIDATES.find(c => c.name === name);
  if (!c) {
    throw new Error(`Unknown candidate '${name}'. Available: ${CANDIDATES.map(c => c.name).join(', ')}`);
  }
  return c;
}
