// Optional cross-encoder reranker. Default candidate: BGE-v2-m3 hosted
// behind MEM_RERANKER_URL. Inserts a final-stage reorder between RRF
// fusion and the application weighted re-rank in
// retrieveMemoriesVectorSearch.
//
// Failure mode: any reranker error (timeout, non-2xx, score-length
// mismatch) falls back to the RRF order silently. The reranker is a
// quality booster, not a correctness boundary.

import { log } from '../infrastructure/logging';

const RERANKER_GLOBAL_ENABLED = process.env.MEM_RERANKER_ENABLED === '1';
const RERANKER_URL = process.env.MEM_RERANKER_URL;
const RERANKER_TIMEOUT_MS = parseInt(process.env.MEM_RERANKER_TIMEOUT_MS ?? '500', 10);

export interface RerankCandidate {
  id: string;
  content: string;
}

export interface RerankOptions {
  /** Per-tenant gate from tenants.memory_reranker_enabled. */
  tenantEnabled: boolean;
  /** Top N candidates to send to the cross-encoder. The rest pass
   *  through unchanged at the tail. */
  topN: number;
}

/** Reranks the top-N candidates by cross-encoder score. Returns the
 *  input order unchanged when disabled or on any failure. */
export async function maybeRerank<T extends RerankCandidate>(
  query: string,
  candidates: T[],
  opts: RerankOptions,
): Promise<T[]> {
  if (!RERANKER_GLOBAL_ENABLED) return candidates;
  if (!opts.tenantEnabled) return candidates;
  if (candidates.length < 2) return candidates;
  if (!RERANKER_URL) {
    log.warn('rerank: MEM_RERANKER_URL not set — falling back to RRF order');
    return candidates;
  }

  const head = candidates.slice(0, opts.topN);
  const tail = candidates.slice(opts.topN);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), RERANKER_TIMEOUT_MS);

    const res = await fetch(RERANKER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        passages: head.map(c => c.content.slice(0, 2000)),
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);

    if (!res.ok) {
      log.warn({ status: res.status }, 'rerank: non-2xx — falling back to RRF order');
      return candidates;
    }

    const body = await res.json() as { scores?: number[] };
    if (!Array.isArray(body.scores) || body.scores.length !== head.length) {
      log.warn(
        { got: body.scores?.length, expected: head.length },
        'rerank: score length mismatch — falling back to RRF order',
      );
      return candidates;
    }

    const pairs = head.map((c, i) => ({ c, score: body.scores![i] }));
    pairs.sort((a, b) => b.score - a.score);
    return [...pairs.map(p => p.c), ...tail];
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'rerank: call failed — falling back to RRF order');
    return candidates;
  }
}
