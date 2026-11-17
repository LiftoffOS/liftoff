// In-process TTL cache for the "does this agent's connector set have any
// knowledge_items?" check that gates corpus_search exposure.
//
// Why: createToolGatewayMcpServer runs on every chat turn and every
// autonomous execution start. Without a cache, every turn pays a ~30-100ms
// round-trip to /api/internal/knowledge/count. Knowledge sync is a slow
// process measured in minutes (cron + extraction job), so a 60-second TTL is
// safe: the worst-case staleness window is well under one user-perceived
// response cycle, and the count is monotonic-ish (rare deletes, frequent
// adds), so a stale-FALSE flips to fresh-TRUE on the next miss.
//
// Cache key: tenant + connector set. Different agents with the same bound
// connectors share entries, which is the common case in a tenant with one
// support team.

import { getPlatformCallbackClient } from '../platform-callback/client';
import { logger } from '../infrastructure/logging';

const TTL_MS = 60_000;
const MAX_ENTRIES = 1_000;  // bound memory; LRU-evict on insert if exceeded

interface CacheEntry {
  hasKnowledge: boolean;
  cachedAt: number;
}

const cache = new Map<string, CacheEntry>();

function cacheKey(tenantId: string, connectorIds: readonly string[]): string {
  // Sort so [c2, c1] and [c1, c2] hash identically.
  return `${tenantId}|${[...connectorIds].sort().join(',')}`;
}

function evictOldestIfFull(): void {
  if (cache.size < MAX_ENTRIES) return;
  // Map iteration order is insertion order; drop the oldest.
  const firstKey = cache.keys().next().value;
  if (firstKey !== undefined) cache.delete(firstKey);
}

/**
 * Returns true when the agent's connector set has at least one synced
 * knowledge_item (or includeManual=true and any manual import exists).
 * Soft-fails to `true` (expose corpus_search) on any error — better than
 * silently dropping the tool from the agent's prompt.
 */
export async function tenantHasBoundKnowledge(args: {
  tenantId: string;
  agentId: string;          // logging context only
  connectorIds: string[];
}): Promise<boolean> {
  // No tenant context → we can't run the knowledge-count check. Match the
  // soft-fail-to-"expose" contract below (better to keep corpus_search than to
  // drop it) and skip the /knowledge/count round-trip that would 400 on the
  // platform with a missing tenantId. If this fires, a caller of
  // createToolGatewayMcpServer isn't wiring tenantId through — logged for it.
  if (!args.tenantId) {
    logger.warn({ agentId: args.agentId }, 'tenantHasBoundKnowledge: missing tenantId; exposing corpus_search');
    return true;
  }
  const key = cacheKey(args.tenantId, args.connectorIds);
  const now = Date.now();

  const hit = cache.get(key);
  if (hit && now - hit.cachedAt < TTL_MS) {
    return hit.hasKnowledge;
  }

  try {
    const client = getPlatformCallbackClient();
    if (!client) {
      // No callback wiring → can't check → expose by default.
      return true;
    }
    // No explicit Content-Type — ServiceClient.buildHeaders defaults to
    // application/json, and passing it here too produces a duplicate that
    // node's fetch comma-joins ("application/json, application/json"),
    // which express.json refuses to parse. PB then saw an empty body and
    // returned 500 (ZodError: tenantId Required) on EVERY exposure check,
    // so this cache never populated and corpus_search was always exposed
    // via the fail-open below. Same WS-C bug class as
    // platform-callback/client.ts postSkillFeedback — see that comment.
    const resp = await client.fetch('platform', '/api/internal/knowledge/count', {
      method: 'POST',
      body: JSON.stringify({
        tenantId: args.tenantId,
        connectorIds: args.connectorIds,
        includeManual: true,
      }),
      breakerKey: 'platform:knowledge-count',
    });
    if (!resp.ok) return true;
    const { count } = (await resp.json()) as { count: number };
    const hasKnowledge = count > 0;

    evictOldestIfFull();
    cache.set(key, { hasKnowledge, cachedAt: now });
    return hasKnowledge;
  } catch (err) {
    logger.warn(
      { err: (err as Error).message, tenantId: args.tenantId, agentId: args.agentId },
      'knowledge exposure check failed; exposing corpus_search by default',
    );
    return true;
  }
}

// Test-only — never call from production code.
export function __resetKnowledgeExposureCache(): void {
  cache.clear();
}

