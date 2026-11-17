// How many knowledge items this workspace has.
//
// The knowledge base is a control-plane table, so this runtime has to ask. The
// landscape is built on a prompt path and on a tool call, neither of which may
// wait on a network round trip, so the answer is cached and the fetch happens
// in the background — the same shape `tenantHasBoundKnowledge` uses for the
// boolean version of this question, and for the same reason.
//
// UNKNOWN IS NOT ZERO. A failed lookup returns null, and the landscape renders
// null by omitting the line entirely rather than saying "0 items". An agent
// told its knowledge base is empty will report that to a person with the same
// confidence it reports everything else.

import { logger } from '../infrastructure/logging';
import { getPlatformCallbackClient } from '../platform-callback/client';

/** Knowledge sync is a cron plus an extraction job, measured in minutes, so a
 *  count this old is never misleading in a way that matters. */
const TTL_MS = 5 * 60 * 1000;

/** Back off after a failure so an outage does not become a request storm on a
 *  path that runs on every prompt build. */
const FAILURE_BACKOFF_MS = 60 * 1000;

interface Entry {
  count: number | null;
  refreshAfter: number;
  refreshing: boolean;
}

const cache = new Map<string, Entry>();

function scheduleRefresh(tenantId: string, entry: Entry): void {
  if (entry.refreshing) return;
  entry.refreshing = true;

  void (async () => {
    try {
      const client = getPlatformCallbackClient();
      if (!client) {
        // No callback wiring (local dev). Stop asking every call.
        entry.refreshAfter = Date.now() + TTL_MS;
        return;
      }
      const resp = await client.fetch('platform', '/api/internal/knowledge/count', {
        method: 'POST',
        body: JSON.stringify({ tenantId, connectorIds: [], includeManual: true, tenantWide: true }),
        breakerKey: 'platform:knowledge-count',
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const { count } = (await resp.json()) as { count: number };
      entry.count = typeof count === 'number' ? count : null;
      entry.refreshAfter = Date.now() + TTL_MS;
    } catch (err) {
      // Leave the previous count in place if there was one; a stale count is
      // better than an unknown, and both are better than a fabricated zero.
      entry.refreshAfter = Date.now() + FAILURE_BACKOFF_MS;
      logger.warn({ err: (err as Error).message, tenantId }, 'knowledge_count_refresh_failed');
    } finally {
      entry.refreshing = false;
    }
  })();
}

/**
 * The cached count, or null when it has never been established.
 *
 * Synchronous by design: this is read while a prompt is being assembled and
 * must never add a network hop to it. The first call for a tenant returns null
 * and starts the fetch; by the next prompt build the real number is in place.
 */
export function getCachedKnowledgeItemCount(tenantId: string): number | null {
  let entry = cache.get(tenantId);
  if (!entry) {
    entry = { count: null, refreshAfter: 0, refreshing: false };
    cache.set(tenantId, entry);
  }
  if (Date.now() >= entry.refreshAfter) scheduleRefresh(tenantId, entry);
  return entry.count;
}

/** Test helper — clears the cache. NOT for prod use. */
export function _resetKnowledgeCountCacheForTesting(): void {
  cache.clear();
}
