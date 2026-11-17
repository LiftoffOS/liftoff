// Semantic similarity between a candidate pitfall skill and the agent's
// existing skills. Used by skill-feedback-service to dedup pitfalls before
// they accrete into internal_agents.skills[].
//
// Embeds candidate + all existing skill texts in one batched call. Locks
// provider AND model so the calibrated thresholds in
// SKILL_DEDUP_MERGE_THRESHOLD / SKILL_DEDUP_FLOOR_THRESHOLD remain valid —
// calibration is done against gemini-embedding-001 at 768d, and neither a
// change to defaultPreference nor a change to the provider's default model may
// silently invalidate the thresholds. The model was the half that was left
// open: pinning the provider stops the vendor moving underneath the numbers,
// and pinning the model stops the vendor's own default doing it.
//
// There is no prompt cache on this path and there cannot be. An embedding is
// not a completion: no vendor offers a prefix cache for one, and the request
// carries no system prompt to mark. What IS repeated here is the INPUT, and
// repeatedly: both callers loop over candidates against the same fixed list, so
// a redistill with 20 new skills against 20 preserved ones asked the vendor for
// the same 20 vectors 20 times. EMBEDDING_CACHE below is the saving that
// actually exists here — the vendor is asked once per distinct text.
//
// Safe because an embedding is a pure function of (provider, model, dimensions,
// taskType, text), and every one of those is in the key. Nothing else about the
// call can change the vector.
//
// Skill name is intentionally excluded from the embedded text: auto-generated
// names like `reflection:<uuid>:<originatingId>` pollute the cosine signal
// with identifier strings.

import { createHash } from 'crypto';
import { embeddingClient } from '@liftoffos/embedding';
import { log } from '../infrastructure/logging';

const EMBED_PROVIDER = 'google' as const;
/** Pinned for the same reason the provider is: the thresholds are calibrated
 *  against this model at this width, and a default that moves underneath them
 *  changes what counts as a duplicate without changing a line of code. */
const EMBED_MODEL = 'gemini-embedding-001';
const EMBED_DIMENSIONS = 768;
const EMBED_TASK_TYPE = 'retrieval_document' as const;

/**
 * Vectors already paid for, keyed by everything that determines them.
 *
 * Bounded and in-process. It is a cost cache, not a store: a cold instance is
 * correct and merely pays what it used to, so nothing here needs to survive a
 * restart or be shared between them.
 *
 * The bound is a count of entries rather than of bytes because every entry is
 * the same size — 768 floats, about 6KB — so 2,000 of them is around 12MB, and
 * an agent's whole skill set is a few dozen. Insertion order is the eviction
 * order, which for this access pattern is the right one: a run works through one
 * agent's skills and then moves on.
 */
const EMBEDDING_CACHE = new Map<string, number[]>();
const EMBEDDING_CACHE_MAX_ENTRIES = 2000;

function cacheKey(text: string): string {
  // The text is hashed rather than stored as the key: a skill instruction runs
  // to 1500 characters and the map would otherwise hold two copies of every
  // corpus it has seen.
  const digest = createHash('sha256').update(text).digest('hex');
  return `${EMBED_PROVIDER}|${EMBED_MODEL}|${EMBED_DIMENSIONS}|${EMBED_TASK_TYPE}|${digest}`;
}

function cachePut(text: string, vector: number[]): void {
  const key = cacheKey(text);
  // Re-inserting moves an entry to the end, so a text that keeps being asked for
  // is not evicted just because it was first seen a long time ago.
  if (EMBEDDING_CACHE.has(key)) EMBEDDING_CACHE.delete(key);
  EMBEDDING_CACHE.set(key, vector);
  while (EMBEDDING_CACHE.size > EMBEDDING_CACHE_MAX_ENTRIES) {
    const oldest = EMBEDDING_CACHE.keys().next();
    if (oldest.done) break;
    EMBEDDING_CACHE.delete(oldest.value);
  }
}

/**
 * Embed `texts`, asking the vendor only for the ones nothing has embedded yet.
 *
 * Order-preserving: the caller indexes into the result by position, and a
 * partial batch that came back in its own order would silently pair every skill
 * with the wrong vector. That is the failure this function exists to not have,
 * so the mapping from input position to result is explicit rather than implied
 * by the call.
 *
 * Throws exactly what `embed` throws, so both callers keep their fail-open
 * behaviour unchanged.
 */
async function embedWithCache(
  texts: string[],
  attribution: { tenantId: string; agentId: string },
  purpose: string,
): Promise<number[][]> {
  const out: Array<number[] | undefined> = texts.map((t) => EMBEDDING_CACHE.get(cacheKey(t)));

  const missingPositions: number[] = [];
  const missingTexts: string[] = [];
  for (let i = 0; i < texts.length; i++) {
    if (out[i] !== undefined) continue;
    // A text repeated WITHIN one batch is asked for once, not once per copy.
    const alreadyQueued = missingTexts.indexOf(texts[i]);
    if (alreadyQueued === -1) {
      missingTexts.push(texts[i]);
    }
    missingPositions.push(i);
  }

  if (missingTexts.length > 0) {
    const response = await embeddingClient.embed({
      provider: EMBED_PROVIDER,
      model: EMBED_MODEL,
      input: missingTexts,
      dimensions: EMBED_DIMENSIONS,
      taskType: EMBED_TASK_TYPE,
      context: {
        tenantId: attribution.tenantId,
        agentId: attribution.agentId,
        purpose,
      },
    });
    // A provider that returns a different number of vectors than it was given
    // inputs has broken the positional contract every caller relies on. Fail
    // rather than pair skills with vectors belonging to other skills.
    if (response.embeddings.length !== missingTexts.length) {
      throw new Error(
        `embedding provider returned ${response.embeddings.length} vectors for `
        + `${missingTexts.length} inputs`,
      );
    }
    for (let i = 0; i < missingTexts.length; i++) {
      cachePut(missingTexts[i], response.embeddings[i]);
    }
    for (const position of missingPositions) {
      out[position] = EMBEDDING_CACHE.get(cacheKey(texts[position]));
    }
  }

  return out.map((vector, i) => {
    if (!vector) {
      throw new Error(`no embedding produced for input ${i}`);
    }
    return vector;
  });
}

/** Test seam. The cache is process-wide, so a test that seeds it would
 *  otherwise leak into the next one. */
export function _resetEmbeddingCacheForTesting(): void {
  EMBEDDING_CACHE.clear();
}

/** Test seam: how many distinct vectors are held right now. */
export function _embeddingCacheSizeForTesting(): number {
  return EMBEDDING_CACHE.size;
}

export interface SkillForSimilarity {
  id: string;
  name: string;
  description: string;
  instruction: string;
  tags: string[];
}

export interface NearestSkillResult {
  matchedSkill: SkillForSimilarity;
  similarity: number;
}

function skillText(s: { description: string; instruction: string }): string {
  return `${s.description}\n${s.instruction}`.trim();
}

function cosine(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return na && nb ? dot / (Math.sqrt(na) * Math.sqrt(nb)) : 0;
}

/**
 * Returns the nearest existing skill to the candidate, by cosine similarity
 * over batched embeddings. Returns null if `existing` is empty or if the
 * embed call fails — caller treats null as "no match → append" (fail-open).
 */
export async function findNearestSkill(
  candidate: { description: string; instruction: string },
  existing: SkillForSimilarity[],
  attribution: { tenantId: string; agentId: string },
): Promise<NearestSkillResult | null> {
  if (existing.length === 0) return null;

  const inputs = [skillText(candidate), ...existing.map(skillText)];
  let embeddings: number[][];
  try {
    embeddings = await embedWithCache(inputs, attribution, 'skill_dedup');
  } catch (err) {
    log.warn(
      { err: (err as Error).message, agentId: attribution.agentId },
      'skill-similarity: embed failed, defaulting to no-match (will append)',
    );
    return null;
  }

  const [candidateVec, ...existingVecs] = embeddings;
  let best: NearestSkillResult | null = null;
  for (let i = 0; i < existing.length; i++) {
    const sim = cosine(candidateVec, existingVecs[i]);
    if (!best || sim > best.similarity) {
      best = { matchedSkill: existing[i], similarity: sim };
    }
  }
  return best;
}

/**
 * Cosine of two skill texts via a single 2-input embed batch. Used by the
 * merge-quality verification: after the merge LLM returns, re-embed the
 * merged skill and check it stays close to both inputs. Returns null on
 * embed failure (caller treats null as "skip verification, accept merge").
 */
export async function pairCosine(
  a: { description: string; instruction: string },
  b: { description: string; instruction: string },
  attribution: { tenantId: string; agentId: string },
): Promise<number | null> {
  try {
    const embeddings = await embedWithCache(
      [skillText(a), skillText(b)],
      attribution,
      'skill_dedup_verify',
    );
    return cosine(embeddings[0], embeddings[1]);
  } catch (err) {
    log.warn(
      { err: (err as Error).message, agentId: attribution.agentId },
      'skill-similarity: verify-embed failed, accepting merge without verification',
    );
    return null;
  }
}
