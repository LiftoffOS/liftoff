// Connector Content Search Service
//
// Hybrid BM25 + HNSW search against the connector_content table.
// Content is opportunistically indexed from tool call results by the
// content indexer in tool-gateway.
//
// Cold-start fallback: if the tenant has no connector_content rows yet,
// fall back to memories with harvest: tags.

import type { Pool, PoolClient } from 'pg';
import { withTenantScope } from '../infrastructure/database';

/** Anything that can run a query. `connector_content` is FORCE RLS as of
 *  migration 372, so in production every one of these is a client already
 *  inside `withTenantScope`; the wider type keeps the internal helpers
 *  testable with a plain pool double. */
type Queryable = Pick<Pool | PoolClient, 'query'>;
import { log } from '../infrastructure/logging';
import { generateEmbedding } from '../memory/embedding';
import { generateHypotheticalDocument } from '../memory/hyde';

export interface SearchResult {
  id: string;
  content: string;
  connectorType: string;
  entityType: string;
  tags: string[];
  score: number;
}

/** What the index actually covers, returned alongside every search. The
 *  connector_content table is OPPORTUNISTIC — it holds only content previously
 *  fetched by tool calls — so an empty result never proves the data does not
 *  exist at the source. Callers surface this so a model can say "not in what
 *  I've seen so far" instead of "it doesn't exist". */
export interface SearchCoverage {
  indexedItems: number;
  oldestIndexedAt: string | null;
  newestIndexedAt: string | null;
}

export async function connectorContentCoverage(
  tenantId: string,
  connectorType?: string,
  queryPool?: Queryable,
): Promise<SearchCoverage> {
  const run = async (q: Queryable): Promise<SearchCoverage> => {
  const params: string[] = [tenantId];
  // `expires_at > NOW()` because BOTH search arms filter on it. Without it the
  // coverage number counts rows the search can never return, so the source
  // reports "N items indexed" beside an empty result — a confident number that
  // is wrong in the one direction this feature exists to prevent.
  let where = 'tenant_id = $1 AND expires_at > NOW()';
  if (connectorType) {
    params.push(connectorType);
    where += ' AND connector_type = $2';
  }
  const res = await q.query(
    `SELECT COUNT(*)::int AS n, MIN(created_at) AS oldest, MAX(created_at) AS newest
     FROM connector_content WHERE ${where}`,
    params,
  );
  const row = res.rows[0] as { n: number; oldest: Date | null; newest: Date | null };
  return {
    indexedItems: row?.n ?? 0,
    oldestIndexedAt: row?.oldest ? new Date(row.oldest).toISOString() : null,
    newestIndexedAt: row?.newest ? new Date(row.newest).toISOString() : null,
  };
  };
  return queryPool ? run(queryPool) : withTenantScope(tenantId, run);
}

type Row = Record<string, any>;

/** Normalise a freeform query into a to_tsquery-safe string. */
function toTsQuery(query: string): string {
  return query
    .trim()
    .replace(/\s+/g, ' ')
    .split(' ')
    .filter(Boolean)
    .join(' & ');
}

function reciprocalRankFusion(
  vectorRows: Row[],
  bm25Rows: Row[],
  k = 60,
): Row[] {
  const scores = new Map<string, { row: Row; rrf: number }>();

  function addList(rows: Row[]): void {
    rows.forEach((row, rank) => {
      const id: string = row.id;
      const contribution = 1 / (k + rank + 1);
      const existing = scores.get(id);
      if (existing) {
        existing.rrf += contribution;
      } else {
        scores.set(id, { row, rrf: contribution });
      }
    });
  }

  addList(vectorRows);
  addList(bm25Rows);

  return Array.from(scores.values())
    .sort((a, b) => b.rrf - a.rrf)
    .map(entry => ({ ...entry.row, rrfScore: entry.rrf }));
}

async function runVectorQuery(
  embeddingJson: string,
  tenantId: string,
  connectorType: string | undefined,
  queryPool: Queryable,
): Promise<Row[]> {
  const sql = `
    SELECT id, content, connector_type, entity_type, tags,
           (embedding <=> $1::vector) AS vector_distance
    FROM connector_content
    WHERE tenant_id = $2
      AND expires_at > NOW()
      AND embedding IS NOT NULL
      AND ($3::text IS NULL OR connector_type = $3)
    ORDER BY embedding <=> $1::vector
    LIMIT 50
  `;
  const result = await queryPool.query(sql, [
    embeddingJson,
    tenantId,
    connectorType ?? null,
  ]);
  return result.rows;
}

async function runBM25Query(
  tsQuery: string,
  tenantId: string,
  connectorType: string | undefined,
  queryPool: Queryable,
): Promise<Row[]> {
  const sql = `
    SELECT id, content, connector_type, entity_type, tags,
           ts_rank(content_tsv, to_tsquery('simple', $1)) AS bm25_rank
    FROM connector_content
    WHERE tenant_id = $2
      AND content_tsv @@ to_tsquery('simple', $1)
      AND expires_at > NOW()
      AND ($3::text IS NULL OR connector_type = $3)
    ORDER BY bm25_rank DESC
    LIMIT 50
  `;
  const result = await queryPool.query(sql, [
    tsQuery,
    tenantId,
    connectorType ?? null,
  ]);
  return result.rows;
}

async function hasConnectorContent(tenantId: string, queryPool: Queryable): Promise<boolean> {
  const result = await queryPool.query(
    'SELECT 1 FROM connector_content WHERE tenant_id = $1 AND expires_at > NOW() LIMIT 1',
    [tenantId],
  );
  return (result.rowCount ?? 0) > 0;
}

/** Cold-start fallback: search memories that have harvest: tags. */
async function fallbackHarvestMemories(
  embeddingJson: string,
  tsQuery: string,
  tenantId: string,
  limit: number,
  queryPool: Queryable,
): Promise<SearchResult[]> {
  const vectorSql = `
    SELECT id, content, 'memory' AS connector_type, 'memory' AS entity_type, tags,
           (embedding <=> $1::vector) AS vector_distance
    FROM memories
    WHERE tenant_id = $2
      AND superseded_by IS NULL
      AND (expires_at IS NULL OR expires_at > NOW())
      AND content_classification NOT IN ('pii', 'sensitive')
      AND embedding IS NOT NULL
      AND EXISTS (SELECT 1 FROM unnest(tags) t WHERE t LIKE 'harvest:%')
    ORDER BY embedding <=> $1::vector
    LIMIT 50
  `;

  const bm25Sql = tsQuery
    ? `
      SELECT id, content, 'memory' AS connector_type, 'memory' AS entity_type, tags,
             0 AS vector_distance
      FROM memories
      WHERE tenant_id = $2
        AND superseded_by IS NULL
        AND (expires_at IS NULL OR expires_at > NOW())
        AND content_classification NOT IN ('pii', 'sensitive')
        AND content_tsv @@ to_tsquery('simple', $1)
        AND EXISTS (SELECT 1 FROM unnest(tags) t WHERE t LIKE 'harvest:%')
      ORDER BY ts_rank(content_tsv, to_tsquery('simple', $1)) DESC
      LIMIT 50
    `
    : null;

  const [vectorResult, bm25Result] = await Promise.all([
    queryPool.query(vectorSql, [embeddingJson, tenantId]),
    bm25Sql ? queryPool.query(bm25Sql, [tsQuery, tenantId]).catch(() => ({ rows: [] })) : Promise.resolve({ rows: [] }),
  ]);

  const merged = reciprocalRankFusion(vectorResult.rows, bm25Result.rows);
  return merged.slice(0, limit).map((row, i) => ({
    id: row.id as string,
    content: row.content as string,
    connectorType: row.connector_type as string,
    entityType: row.entity_type as string,
    tags: (row.tags as string[]) || [],
    score: 1 / (60 + i + 1),
  }));
}

export async function searchConnectorContent(
  params: {
    tenantId: string;
    query: string;
    connectorType?: string;
    limit?: number;
    agentId?: string;
    /** A retrieval vector the caller already paid for, as the JSON array
     *  Postgres casts to `vector`. When present, HyDE and the embedding call
     *  are skipped entirely.
     *
     *  Retrieval here costs an LLM call (HyDE) plus an embedding, and
     *  `memory_retrieve` pays exactly the same pair for the same query. A
     *  caller that searches both sources would otherwise buy two hypothetical
     *  documents describing one question. */
    embeddingJson?: string;
    /** Whether an empty index may fall back to harvest-tagged MEMORIES.
     *
     *  Default true, which is right for a caller whose only source this is —
     *  an external MCP client gets something rather than nothing. It is wrong
     *  for a caller that ALSO searches memory separately: the fallback returns
     *  rows stamped `connector_type: 'memory'`, so the same content comes back
     *  twice under two source labels, and the coverage object reports zero
     *  indexed items beside a non-empty result. Pass false and get an honest
     *  empty. */
    coldStartFallback?: boolean;
    /** Run the BM25 arm only, without building a retrieval vector.
     *
     *  For a caller that already tried and found the embedding provider down.
     *  Without it, that caller hands over a blank and this function tries
     *  again — one failed provider call per source, per search, for as long as
     *  the outage lasts. Lexical retrieval still answers; it just answers less
     *  well, which is the right trade against answering nothing three times. */
    lexicalOnly?: boolean;
  },
  queryPool?: Queryable,
): Promise<SearchResult[]> {
  // Buy the retrieval vector BEFORE taking a connection. HyDE and the
  // embedding are network round trips, and `connector_content` is FORCE RLS so
  // the queries below run inside `withTenantScope` — holding a pooled client
  // across an LLM call would tie up a connection for the length of that call
  // and exhaust the pool under any real concurrency.
  let resolved = params;
  if (!params.embeddingJson && !params.lexicalOnly) {
    const hypotheticalDoc = await generateHypotheticalDocument(
      params.query,
      params.tenantId,
      params.agentId,
    ).catch(() => params.query);

    const embedding = await generateEmbedding(hypotheticalDoc, {
      tenantId: params.tenantId,
      ...(params.agentId ? { agentId: params.agentId } : {}),
      purpose: 'embedding_retrieval',
      taskType: 'retrieval_query',
    });
    resolved = { ...params, embeddingJson: JSON.stringify(embedding) };
  }

  return queryPool
    ? searchWithin(resolved, queryPool)
    : withTenantScope(resolved.tenantId, (client) => searchWithin(resolved, client));
}

async function searchWithin(
  params: Parameters<typeof searchConnectorContent>[0],
  queryPool: Queryable,
): Promise<SearchResult[]> {
  const limit = params.limit ?? 10;
  const tsQuery = toTsQuery(params.query);

  // HyDE + embedding, unless the caller supplied a vector or told us the
  // provider is unreachable.
  let embeddingJson = params.embeddingJson;
  if (!embeddingJson && params.lexicalOnly) {
    if (!tsQuery) {
      // No vector and nothing to match lexically: there is no query left to run.
      log.info({ tenantId: params.tenantId }, 'connector-content: lexical-only with an unusable query');
      return [];
    }
    const rows = await runBM25Query(tsQuery, params.tenantId, params.connectorType, queryPool);
    return rows.slice(0, limit).map((row, i) => ({
      id: row.id as string,
      content: row.content as string,
      connectorType: row.connector_type as string,
      entityType: row.entity_type as string,
      tags: (row.tags as string[]) || [],
      score: 1 / (60 + i + 1),
    }));
  }
  // No vector acquisition here by design: `searchConnectorContent` resolves it
  // before opening the tenant scope, so no pooled connection is held across an
  // LLM round trip.
  if (!embeddingJson) {
    log.info(
      { tenantId: params.tenantId },
      'connector-content: no retrieval vector; running lexical arm only',
    );
    const rows = tsQuery
      ? await runBM25Query(tsQuery, params.tenantId, params.connectorType, queryPool)
      : [];
    return rows.slice(0, limit).map((row, i) => ({
      id: row.id as string,
      content: row.content as string,
      connectorType: row.connector_type as string,
      entityType: row.entity_type as string,
      tags: (row.tags as string[]) || [],
      score: 1 / (60 + i + 1),
    }));
  }

  // Cold-start check
  const hasContent = await hasConnectorContent(params.tenantId, queryPool);
  if (!hasContent) {
    if (params.coldStartFallback === false) {
      log.info(
        { tenantId: params.tenantId },
        'connector-content: index empty, cold-start fallback suppressed by caller',
      );
      return [];
    }
    log.info({ tenantId: params.tenantId }, 'connector-content: cold-start fallback to harvest memories');
    return fallbackHarvestMemories(
      embeddingJson,
      tsQuery,
      params.tenantId,
      limit,
      queryPool,
    );
  }

  // Parallel vector + BM25
  const [vectorRows, bm25Rows] = await Promise.all([
    runVectorQuery(embeddingJson, params.tenantId, params.connectorType, queryPool),
    tsQuery
      ? runBM25Query(tsQuery, params.tenantId, params.connectorType, queryPool)
      : Promise.resolve([]),
  ]);

  const merged = reciprocalRankFusion(vectorRows, bm25Rows);

  return merged.slice(0, limit).map((row, i) => ({
    id: row.id as string,
    content: row.content as string,
    connectorType: row.connector_type as string,
    entityType: row.entity_type as string,
    tags: (row.tags as string[]) || [],
    score: row.rrfScore ?? 1 / (60 + i + 1),
  }));
}
