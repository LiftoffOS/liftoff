// Enumerating entities on ANY composio_managed connector, with no per-vendor
// code.
//
// WHY THIS EXISTS
// 80 connectors in the catalog declare a Composio `toolkitSlug` and have no
// client of their own. Browse could not serve any of them, so a person pointing
// a team at Airtable, Monday, Todoist, Discord or Coda was told the connection
// held nothing. Writing 80 clients to fix that would rebuild, one file at a
// time, exactly the per-vendor sprawl that the browse route was refactored to
// delete.
//
// Composio already is the abstraction. Every toolkit publishes its operations,
// and the one that lists a thing is named after the thing
// (`AIRTABLE_LIST_BASES`, `TODOIST_GET_PROJECTS`). So the tool is discovered
// from the toolkit rather than hardcoded, which is the same move
// mcp-entity-list.ts makes for vendor MCP servers — see entity-enumeration.ts
// for the shared matching rules.
//
// A connector added to the catalog with a toolkitSlug is therefore browseable
// with no code change at all. That is the property that was missing.

import { getComposio } from '../oauth/composio-client.js';
import { logger } from '../infra/logging.js';
import type { ListFilters, ListResult } from './types.js';
import {
  pickEnumeratingTool,
  extractRecordArray,
  toExternalRecords,
} from './entity-enumeration.js';

/** Toolkits are small (tens of operations), so one unfiltered fetch is cheaper
 *  and more reliable than trusting a server-side search to rank our entity
 *  first. Bounded well above any real toolkit. */
const TOOL_FETCH_LIMIT = 300;

/** Discovery is per (toolkit, entity) and the answer does not change between
 *  requests, while a picker re-queries on every keystroke-driven refetch. The
 *  cache is per process and unbounded only in the number of toolkits we have,
 *  which is bounded by the catalog. */
const toolCache = new Map<string, string | null>();

export function clearComposioToolCache(): void {
  toolCache.clear();
}

async function resolveTool(toolkitSlug: string, entityType: string): Promise<string | null> {
  const key = `${toolkitSlug}::${entityType.toLowerCase()}`;
  const cached = toolCache.get(key);
  if (cached !== undefined) return cached;

  const raw = await getComposio().tools.getRawComposioTools({
    toolkits: [toolkitSlug],
    limit: TOOL_FETCH_LIMIT,
  });

  // The SDK returns objects carrying a `slug`; the shared matcher works on
  // `name`, so present the slug as the name to match against. The slug is what
  // execute() takes, and it is the part that follows the naming convention.
  const candidates = (raw ?? []).map(t => ({
    name: String((t as Record<string, unknown>).slug ?? ''),
  })).filter(t => t.name);

  const hit = pickEnumeratingTool(candidates, entityType);
  toolCache.set(key, hit?.name ?? null);
  return hit?.name ?? null;
}

/**
 * List `entityType` on a composio_managed connector.
 *
 * Returns `unsupported: true` when the toolkit publishes no operation that
 * enumerates this entity — a real answer meaning "this connector cannot list
 * that", as distinct from an empty array claiming the account holds none.
 */
export async function listViaComposioTool(args: {
  toolkitSlug: string;
  connectedAccountId: string;
  tenantId: string;
  entityType: string;
  filters?: ListFilters;
}): Promise<ListResult> {
  const { toolkitSlug, connectedAccountId, tenantId, entityType, filters } = args;

  const tool = await resolveTool(toolkitSlug, entityType);
  if (!tool) {
    logger.info('Composio browse: toolkit publishes no enumerator for entity', {
      toolkitSlug,
      entityType,
    });
    return { records: [], hasMore: false, unsupported: true };
  }

  // Arguments are deliberately minimal. Every toolkit names its paging and
  // parent parameters differently, and sending a guess produces a vendor
  // validation error rather than a list. The first page unfiltered is the
  // question a destination picker is actually asking.
  const parent = (filters as Record<string, unknown> | undefined)?.folderId;
  const callArgs: Record<string, unknown> = {};
  if (parent) {
    // When a parent IS known, offer it under the handful of spellings toolkits
    // actually use. Extra keys are ignored by Composio's schema validation.
    callArgs.id = parent;
    callArgs.parent_id = parent;
  }

  const resp = await getComposio().tools.execute(tool, {
    userId: tenantId,
    connectedAccountId,
    arguments: callArgs,
    dangerouslySkipVersionCheck: true,
  });

  if (resp.successful === false) {
    // A vendor refusal is not an empty account. Surfaced as an error so the
    // person is told something is wrong rather than being shown a clean,
    // confident, empty list.
    throw new Error(resp.error || `${tool} returned successful=false`);
  }

  const rows = extractRecordArray(resp.data);
  return { records: toExternalRecords(rows), hasMore: false };
}
