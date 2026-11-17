// What this workspace's data actually looks like.
//
// An agent's whole knowledge of its systems is the prompt's capability block —
// which systems it can reach, and nothing about what is in them:
//
//     - support-slack (slack)
//     - crm (hubspot)
//
// So every task opens with exploratory calls just to find out what it is
// working with, and every one of those costs vendor quota. This answers the
// question once, from local tables, with no vendor call at all.
//
// HARD-BOUNDED. The consumers are prompts: the session tier of an agent's
// system prompt, a distillation section, and an advisor whose entire context
// budget is 8,000 tokens. An unbounded landscape would crowd out the
// instructions it is meant to support. When the bound drops detail, that is
// STATED rather than silently applied — a truncated list that does not say so
// reads as a complete one, which is the same confident-false-negative failure
// an incomplete index produces.

import { logger } from '../infrastructure/logging';
import { getCachedKnowledgeItemCount } from './knowledge-count-client';

export interface ConnectorLandscape {
  connectorType: string;
  /** Live entity counts per entity type. Deleted rows are excluded — they are
   *  kept for history, not for describing what exists now. */
  entityCounts: Record<string, number>;
  hydratedCount: number;
  stubCount: number;
  oldestObservedAt: string | null;
  newestObservedAt: string | null;
}

export interface DataLandscape {
  connectors: ConnectorLandscape[];
  /** Content already fetched and indexed, which `search` can answer from
   *  without touching a vendor. */
  indexedContext: { items: number; oldest: string | null; newest: string | null };
  /** Knowledge-base items, which the control plane owns.
   *
   *  NULL means "not known right now", not "none". A failed lookup reported as
   *  0 would tell an agent the knowledge base is empty, which is exactly the
   *  confident false negative this whole surface exists to avoid. */
  knowledgeItems: number | null;
  /** True when the size bound dropped detail. */
  truncated: boolean;
}

/** Serialized ceiling. The advisor consuming this has an 8,000-token context
 *  budget in total, so the landscape gets a small fraction of it. */
const MAX_SERIALIZED_BYTES = 8_000;

/** Entity types listed per connector before the rest are folded away. */
const MAX_ENTITY_TYPES_PER_CONNECTOR = 12;

function serializedSize(landscape: DataLandscape): number {
  return Buffer.byteLength(JSON.stringify(landscape), 'utf8');
}

/**
 * Shrink until it fits, dropping the least informative detail first.
 *
 * Order is deliberate: long tails of entity types go before whole connectors,
 * because knowing a connector exists at all is worth more to an agent than
 * knowing the exact count of its twentieth entity type.
 */
export function boundLandscape(landscape: DataLandscape): DataLandscape {
  let out = landscape;
  if (serializedSize(out) <= MAX_SERIALIZED_BYTES) return out;

  // 1. Trim each connector's entity-type list to its largest types.
  out = {
    ...out,
    truncated: true,
    connectors: out.connectors.map((c) => {
      const entries = Object.entries(c.entityCounts).sort((a, b) => b[1] - a[1]);
      if (entries.length <= MAX_ENTITY_TYPES_PER_CONNECTOR) return c;
      return {
        ...c,
        entityCounts: Object.fromEntries(entries.slice(0, MAX_ENTITY_TYPES_PER_CONNECTOR)),
      };
    }),
  };
  if (serializedSize(out) <= MAX_SERIALIZED_BYTES) return out;

  // 2. Drop whole connectors, smallest first, so the biggest parts of the
  //    workspace are the ones that survive.
  const bySize = [...out.connectors].sort(
    (a, b) =>
      Object.values(b.entityCounts).reduce((s, n) => s + n, 0) -
      Object.values(a.entityCounts).reduce((s, n) => s + n, 0),
  );
  while (bySize.length > 1 && serializedSize({ ...out, connectors: bySize }) > MAX_SERIALIZED_BYTES) {
    bySize.pop();
  }
  return { ...out, connectors: bySize, truncated: true };
}

/**
 * Read the landscape for one tenant.
 *
 * Local reads only, plus a CACHED knowledge count — the knowledge base lives in
 * the control plane, so the count is read from a background-refreshed cache
 * rather than fetched inline. Nothing here waits on the network.
 *
 * `knowledgeItems` may be supplied by the caller, and is when the control plane
 * is the caller: it owns that table, and having it ask us so we can ask it back
 * would nest a network call inside one it is already waiting on. An explicitly
 * supplied value always wins over the cache.
 */
export async function getDataLandscape(args: {
  tenantId: string;
  knowledgeItems?: number | null;
}): Promise<DataLandscape> {
  const knowledgeItems = args.knowledgeItems !== undefined
    ? args.knowledgeItems
    : getCachedKnowledgeItemCount(args.tenantId);

  const empty: DataLandscape = {
    connectors: [],
    indexedContext: { items: 0, oldest: null, newest: null },
    knowledgeItems,
    truncated: false,
  };

  try {
    // Both reads run under tenant scope: `connector_entities` is FORCE-RLS from
    // migration 370, and `connector_content` from 372. The explicit tenant
    // predicate stays on each — belt and braces, and it keeps the query
    // readable about what it is counting.
    const { withTenantScope } = await import('../infrastructure/database');

    const censusRows = await withTenantScope(args.tenantId, (client) =>
      client.query<{
        connector_type: string;
        entity_type: string;
        n: string;
        hydrated: string;
        stubs: string;
        oldest: Date | null;
        newest: Date | null;
      }>(
        `SELECT connector_type,
                entity_type,
                COUNT(*)::bigint                                            AS n,
                COUNT(*) FILTER (WHERE hydration_state = 'hydrated')::bigint AS hydrated,
                COUNT(*) FILTER (WHERE hydration_state = 'stub')::bigint     AS stubs,
                MIN(created_at)                                              AS oldest,
                MAX(COALESCE(last_touched_at, created_at))                   AS newest
           FROM connector_entities
          WHERE tenant_id = $1 AND NOT deleted
          GROUP BY connector_type, entity_type`,
        [args.tenantId],
      ),
    );

    const byConnector = new Map<string, ConnectorLandscape>();
    for (const row of censusRows.rows) {
      let c = byConnector.get(row.connector_type);
      if (!c) {
        c = {
          connectorType: row.connector_type,
          entityCounts: {},
          hydratedCount: 0,
          stubCount: 0,
          oldestObservedAt: null,
          newestObservedAt: null,
        };
        byConnector.set(row.connector_type, c);
      }
      c.entityCounts[row.entity_type] = Number.parseInt(row.n, 10) || 0;
      c.hydratedCount += Number.parseInt(row.hydrated, 10) || 0;
      c.stubCount += Number.parseInt(row.stubs, 10) || 0;
      if (row.oldest) {
        const iso = new Date(row.oldest).toISOString();
        if (!c.oldestObservedAt || iso < c.oldestObservedAt) c.oldestObservedAt = iso;
      }
      if (row.newest) {
        const iso = new Date(row.newest).toISOString();
        if (!c.newestObservedAt || iso > c.newestObservedAt) c.newestObservedAt = iso;
      }
    }

    const indexed = await withTenantScope(args.tenantId, (client) =>
      client.query<{ n: string; oldest: Date | null; newest: Date | null }>(
        `SELECT COUNT(*)::bigint AS n, MIN(created_at) AS oldest, MAX(created_at) AS newest
           FROM connector_content
          WHERE tenant_id = $1 AND expires_at > NOW()`,
        [args.tenantId],
      ),
    );
    const idx = indexed.rows[0];

    return boundLandscape({
      connectors: [...byConnector.values()].sort((a, b) =>
        a.connectorType.localeCompare(b.connectorType),
      ),
      indexedContext: {
        items: Number.parseInt(idx?.n ?? '0', 10) || 0,
        oldest: idx?.oldest ? new Date(idx.oldest).toISOString() : null,
        newest: idx?.newest ? new Date(idx.newest).toISOString() : null,
      },
      knowledgeItems,
      truncated: false,
    });
  } catch (err) {
    // Never throws. Every consumer is a prompt builder, and a failed landscape
    // read must cost an agent its map, not its turn.
    logger.warn({ err: (err as Error).message, tenantId: args.tenantId }, 'data_landscape_read_failed');
    return empty;
  }
}

/**
 * Render the landscape as the compact block that goes into a prompt.
 *
 * States coverage in words. "12 channels" and "12 channels seen so far" are
 * different claims, and only the second one is true.
 */
export function renderLandscapeBlock(landscape: DataLandscape): string {
  const hasConnectors = landscape.connectors.length > 0;
  const hasIndexed = landscape.indexedContext.items > 0;
  const hasKnowledge = landscape.knowledgeItems !== null && landscape.knowledgeItems > 0;

  // "Nothing catalogued" has to mean nothing, across every source. Deciding it
  // from connectors and indexed content alone made the knowledge line below
  // unreachable for a workspace whose only catalogued data IS its knowledge
  // base, and told that workspace to treat every system as unexplored.
  if (!hasConnectors && !hasIndexed && !hasKnowledge) {
    return (
      'YOUR DATA\n' +
      'Nothing has been catalogued for this workspace yet. Treat every system as unexplored: ' +
      'list before you assume, and do not report that something does not exist on the basis of ' +
      'having found nothing here.'
    );
  }

  const lines: string[] = ['YOUR DATA'];

  for (const c of landscape.connectors) {
    const counts = Object.entries(c.entityCounts)
      .sort((a, b) => b[1] - a[1])
      .map(([type, n]) => `${n} ${type}${n === 1 ? '' : 's'}`)
      .join(', ');
    const since = c.oldestObservedAt ? ` (seen since ${c.oldestObservedAt.slice(0, 10)})` : '';
    lines.push(`- ${c.connectorType}: ${counts || 'nothing catalogued'}${since}`);
  }

  if (landscape.indexedContext.items > 0) {
    const from = landscape.indexedContext.oldest
      ? ` from ${landscape.indexedContext.oldest.slice(0, 10)}`
      : '';
    lines.push(
      `- Already-fetched content${from}: ${landscape.indexedContext.items} items, ` +
      'searchable instantly with `search` at no cost to the connected system.',
    );
  }

  if (landscape.knowledgeItems !== null && landscape.knowledgeItems > 0) {
    lines.push(`- Knowledge base: ${landscape.knowledgeItems} items, searchable with \`corpus_search\`.`);
  }

  // Say plainly when the connected systems specifically are uncatalogued, so a
  // knowledge-only landscape does not read as a complete picture of the data.
  if (!hasConnectors && !hasIndexed) {
    lines.push(
      'Nothing has been catalogued from your connected systems yet. Treat those as unexplored, ' +
      'and list before you assume.',
    );
  }

  lines.push(
    'These are the things catalogued so far, not everything that exists. ' +
    'A count is a floor, and an absence here is not an absence at the source.',
  );

  if (landscape.truncated) {
    lines.push('This summary was shortened; some systems or entity types are not listed.');
  }

  return lines.join('\n');
}
