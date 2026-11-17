// Module-local 10-second cache for individual feature-flag reads from
// the web-tools spend monitor. PB stores numeric overrides in
// feature_flags.value_num (verified at feature-flags/repository.ts:100,
// 'value_num' column, exposed as FeatureFlag.valueNum: number | null).
// `enabled = false` means the override is suppressed regardless of value.
//
// Without this cache, monitorVendorSpend (15-min cadence) issues one DB
// roundtrip per (vendor × runaway-tool) combination per tick.

import { FeatureFlagRepository } from '../feature-flags/repository';

const TTL_MS = 10_000;
const repo   = new FeatureFlagRepository();

interface CacheEntry {
  at:        number;
  valueNum:  number | null;
  enabled:   boolean;
}

const cache = new Map<string, CacheEntry>();

/**
 * Returns the numeric value of a feature flag, or null if the flag does
 * not exist OR is disabled. Caches per-key for 10s.
 */
export async function getCachedFlagNumber(key: string): Promise<number | null> {
  const hit = cache.get(key);
  if (hit && Date.now() - hit.at < TTL_MS) {
    return hit.enabled ? hit.valueNum : null;
  }
  const flag = await repo.findByKey(key);
  const entry: CacheEntry = {
    at:       Date.now(),
    valueNum: flag?.valueNum ?? null,
    enabled:  flag?.enabled ?? false,
  };
  cache.set(key, entry);
  return entry.enabled ? entry.valueNum : null;
}

export function _resetFlagCache(): void { cache.clear(); }   // for tests
