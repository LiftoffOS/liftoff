// Standard offline retrieval metrics, computed on a single (ranked,
// cited) pair. Aggregation across events is in report.ts.

export function recallAtK(ranked: string[], cited: Set<string>, k: number): number {
  if (cited.size === 0) return 0;
  const topK = ranked.slice(0, k);
  let hits = 0;
  for (const id of topK) if (cited.has(id)) hits++;
  return hits / cited.size;
}

export function mrr(ranked: string[], cited: Set<string>): number {
  for (let i = 0; i < ranked.length; i++) {
    if (cited.has(ranked[i])) return 1 / (i + 1);
  }
  return 0;
}

export function ndcgAtK(ranked: string[], cited: Set<string>, k: number): number {
  let dcg = 0;
  for (let i = 0; i < Math.min(k, ranked.length); i++) {
    if (cited.has(ranked[i])) dcg += 1 / Math.log2(i + 2);
  }
  const idealHits = Math.min(cited.size, k);
  let idcg = 0;
  for (let i = 0; i < idealHits; i++) idcg += 1 / Math.log2(i + 2);
  return idcg > 0 ? dcg / idcg : 0;
}

export interface EventScore {
  invocationId: string;
  tenantId: string;
  recallAt5: number;
  recallAt10: number;
  mrr: number;
  ndcgAt10: number;
}

export function scoreEvent(
  ranked: string[],
  cited: string[],
): Omit<EventScore, 'invocationId' | 'tenantId'> {
  const citedSet = new Set(cited);
  return {
    recallAt5: recallAtK(ranked, citedSet, 5),
    recallAt10: recallAtK(ranked, citedSet, 10),
    mrr: mrr(ranked, citedSet),
    ndcgAt10: ndcgAtK(ranked, citedSet, 10),
  };
}
