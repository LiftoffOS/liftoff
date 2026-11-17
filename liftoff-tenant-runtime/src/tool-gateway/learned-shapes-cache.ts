// Accepted response shapes, cached the way capability states are.
//
// The gate consults declarations on the hot path of every write, so a database
// read there is not an option. Accepted shapes are therefore refreshed on a TTL
// and served from memory, and a refresh that fails serves what it had — the
// store throws on a database error rather than answering "nothing accepted",
// so the two can be told apart here, and a failed refresh keeps the last
// known-good set and tries again sooner than the TTL.
//
// Fails OPEN, with one bound. A hiccup that emptied this would strip tools of
// declarations they legitimately have, turning every judged write on that
// connector into an unjudged one — coverage disappearing rather than an
// outage, which is the harder failure to notice. So a cold instance's first
// governed call for a tenant WAITS for the initial load, up to a bound, rather
// than being judged against an empty set because it happened to be first.

import { acceptedShapesFor, type LearnedShape } from './learned-shapes-store';
import { logger } from '../infrastructure/logging';

const TTL_MS = 5 * 60_000;
/** After a failed refresh: sooner than the TTL, later than a tight loop. */
const RETRY_MS = 30_000;
/** How long a governed call waits for a tenant's first load before proceeding
 *  with what is there. Long enough for one indexed query; short enough that a
 *  database that is down does not stall every write behind it. */
const FIRST_LOAD_BOUND_MS = 1_500;

interface Entry {
  shapes: Map<string, LearnedShape[]>;
  staleAt: number;
  /** True once ANY refresh has succeeded; until then the set is not "empty",
   *  it is unknown. */
  loaded: boolean;
  refreshing: Promise<void> | null;
}
const byTenant = new Map<string, Entry>();

function entryFor(tenantId: string): Entry {
  let entry = byTenant.get(tenantId);
  if (!entry) {
    entry = { shapes: new Map(), staleAt: 0, loaded: false, refreshing: null };
    byTenant.set(tenantId, entry);
  }
  return entry;
}

/**
 * Wait for a tenant's accepted shapes to be loaded once, bounded.
 *
 * Called before a governed call consults the cache. On an instance that has
 * loaded this tenant before it returns at once; on a cold one it waits for
 * the first load up to the bound, then proceeds with whatever is there and
 * says so. The load continues in the background either way.
 */
export async function ensureAcceptedShapesLoaded(tenantId: string, boundMs = FIRST_LOAD_BOUND_MS): Promise<void> {
  const entry = entryFor(tenantId);
  if (entry.loaded) return;
  // A load that failed set the retry time; until it comes, a governed call
  // proceeds with the (unknown, empty) set rather than asking again and
  // waiting the bound on every call through an outage. A refresh already in
  // progress is joined.
  if (!entry.refreshing && Date.now() < entry.staleAt) return;
  const load = refresh(tenantId);
  let timer: NodeJS.Timeout | undefined;
  const bound = new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), boundMs); });
  try {
    const outcome = await Promise.race([load.then(() => 'loaded' as const), bound]);
    if (outcome === 'timeout') {
      logger.warn({ tenantId, boundMs }, 'learned_shapes_first_load_slow: judging against what is loaded so far');
    }
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Accepted paths for one tool, or none. Synchronous: the hot path cannot wait. */
export function acceptedReturnsIds(
  tenantId: string,
  connectorType: string,
  actionType: string,
  /** The server alias for a vendor-hosted or custom server's tool; omit for a
   *  catalog connector. Two servers of one type do not share a learned shape. */
  serverAlias = '',
): Array<{ entityType: string; path: string }> {
  const entry = entryFor(tenantId);
  if (Date.now() >= entry.staleAt) void refresh(tenantId);
  const found = entry.shapes.get(`${serverAlias || connectorType}.${actionType}`) ?? [];
  // A path accepted without anyone naming what it identifies still says where
  // the id is, which is the half the gate actually matches on.
  return found.map((s) => ({ entityType: s.entityType ?? 'record', path: s.path }));
}

/** One refresh at a time per tenant; a caller during a refresh joins it. */
function refresh(tenantId: string): Promise<void> {
  const entry = entryFor(tenantId);
  if (entry.refreshing) return entry.refreshing;
  entry.refreshing = (async () => {
    try {
      entry.shapes = await acceptedShapesFor(tenantId);
      entry.loaded = true;
      entry.staleAt = Date.now() + TTL_MS;
    } catch (err) {
      // The last known-good set stays. Retry sooner than the TTL; a set that
      // was never loaded stays "unknown" and the next governed call waits
      // for it again.
      entry.staleAt = Date.now() + RETRY_MS;
      logger.warn({ err: (err as Error).message, tenantId }, 'learned_shapes_refresh_failed: serving the last known-good set');
    } finally {
      entry.refreshing = null;
    }
  })();
  return entry.refreshing;
}

/** Test helper — clears the cache. NOT for production use. */
export function _resetLearnedShapesCacheForTesting(): void {
  byTenant.clear();
}
