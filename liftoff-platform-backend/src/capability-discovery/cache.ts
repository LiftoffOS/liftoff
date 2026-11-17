// Capability discovery — short-TTL query cache.
//
// Caches the EXPENSIVE stage only: live-source retrieval + the judge call.
// Scoring (route preference, evidence, final ranking) is recomputed on every
// call because it depends on the caller's bindings and the tenant's own
// execution evidence — which is also why tenantId and boundConnectorTypes are
// deliberately OUT of the key.
//
// In-memory on purpose: repeat intents cluster heavily and the TTL is short
// enough that live stats stay honest. A table only becomes worth it if
// cross-instance sharing proves necessary — do not add one speculatively.

import { CACHE_TTL_MS } from './config';
import type { Candidate, CapabilitySpec, JudgeVerdict } from './types';

export interface CachedQuery {
  candidates: Candidate[];
  verdicts: JudgeVerdict[];
}

interface Entry {
  value: CachedQuery;
  expiresAt: number;
}

const store = new Map<string, Entry>();

export function cacheKey(spec: CapabilitySpec): string {
  return JSON.stringify({
    t: (spec.targetSystem ?? '').toLowerCase().trim(),
    o: spec.operation.toLowerCase().trim(),
    e: spec.entity.toLowerCase().trim(),
    m: spec.mode,
    ai: [...spec.availableInputs].map((s) => s.toLowerCase().trim()).sort(),
    of: [...spec.requiredOutputFields].map((s) => s.toLowerCase().trim()).sort(),
  });
}

export function getCached(spec: CapabilitySpec): CachedQuery | null {
  const key = cacheKey(spec);
  const hit = store.get(key);
  if (!hit) return null;
  if (hit.expiresAt < Date.now()) {
    store.delete(key);
    return null;
  }
  return hit.value;
}

/** Degraded outcomes are not cached: a timeout must not be remembered for 15
 *  minutes when the next call would likely succeed. */
export function setCached(spec: CapabilitySpec, value: CachedQuery): void {
  store.set(cacheKey(spec), { value, expiresAt: Date.now() + CACHE_TTL_MS });
}
