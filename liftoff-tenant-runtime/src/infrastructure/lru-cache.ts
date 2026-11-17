// Tiny in-house LRU cache.
//
// Replaces the `lru-cache` npm dep for the two callsites that need it
// (tenant_runtime_config resolver + trajectory recorder). v5 ships at the
// top of TR's node_modules; v10+ ships nested under googleapis. Pinning to
// either external version forces a dep-tree negotiation; an internal
// implementation sidesteps it.
//
// Semantics:
//   - max entries: oldest by access order is evicted when set() would exceed
//     `max`.
//   - ttl: when set, get() returns undefined for entries older than ttlMs
//     and deletes them (lazy expiry; we do not maintain a timer wheel).
//
// Not thread-safe — Node's event loop is single-threaded so this is fine
// for our usage. Not designed for high-cardinality (>100K) workloads.

export interface LruCacheOptions {
  /** Hard cap on entries. Required. */
  max: number;
  /** Optional time-to-live per entry, in milliseconds. Omit for no expiry. */
  ttlMs?: number;
}

export class LruCache<K, V> {
  private readonly max: number;
  private readonly ttlMs: number | undefined;
  private readonly map = new Map<K, { value: V; expiresAt: number | undefined }>();

  constructor(opts: LruCacheOptions) {
    if (!Number.isInteger(opts.max) || opts.max < 1) {
      throw new Error(`LruCache: max must be a positive integer (got ${opts.max})`);
    }
    this.max = opts.max;
    this.ttlMs = opts.ttlMs;
  }

  get(key: K): V | undefined {
    const entry = this.map.get(key);
    if (!entry) return undefined;
    if (entry.expiresAt !== undefined && Date.now() > entry.expiresAt) {
      this.map.delete(key);
      return undefined;
    }
    // Re-insert to bump LRU position.
    this.map.delete(key);
    this.map.set(key, entry);
    return entry.value;
  }

  set(key: K, value: V): void {
    if (this.map.has(key)) this.map.delete(key);
    const expiresAt = this.ttlMs === undefined ? undefined : Date.now() + this.ttlMs;
    this.map.set(key, { value, expiresAt });
    if (this.map.size > this.max) {
      // Evict the oldest (first inserted) entry.
      const firstKey = this.map.keys().next().value;
      if (firstKey !== undefined) this.map.delete(firstKey as K);
    }
  }

  delete(key: K): boolean {
    return this.map.delete(key);
  }

  get size(): number {
    return this.map.size;
  }
}
