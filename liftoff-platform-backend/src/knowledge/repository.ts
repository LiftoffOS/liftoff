import { withTenantScope, withAdminScope } from '../infrastructure/database'
import { enqueueKnowledgeOutbox, type OutboxRowRef } from './outbox'
import type {
  KnowledgeItem,
  KnowledgeWebhookSubscription,
  CreateKnowledgeItemInput,
  ContentType,
  SyncStatus,
  ImportMode,
  ExtractionStatus,
} from './types'

function mapRow(row: Record<string, unknown>): KnowledgeItem {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    title: row.title as string,
    sourceUrl: (row.source_url as string | null) ?? null,
    connectorId: (row.connector_id as string | null) ?? null,
    connectorType: (row.connector_type as string | null) ?? null,
    externalId: (row.external_id as string | null) ?? null,
    contentType: row.content_type as ContentType,
    excerpt: (row.excerpt as string | null) ?? null,
    metadata: (row.metadata as Record<string, unknown>) ?? {},
    importMode: row.import_mode as ImportMode,
    syncStatus: row.sync_status as SyncStatus,
    lastSyncedAt: row.last_synced_at ? (row.last_synced_at as Date).toISOString() : null,
    syncError: (row.sync_error as string | null) ?? null,
    parentId: (row.parent_id as string | null) ?? null,
    extractionStatus: (row.extraction_status as ExtractionStatus) ?? 'none',
    extractedText: (row.extracted_text as string | null) ?? null,
    extractedAt: row.extracted_at ? (row.extracted_at as Date).toISOString() : null,
    createdAt: (row.created_at as Date).toISOString(),
    updatedAt: (row.updated_at as Date).toISOString(),
  }
}

function mapWebhookRow(row: Record<string, unknown>): KnowledgeWebhookSubscription {
  return {
    id: row.id as string,
    tenantId: row.tenant_id as string,
    connectorId: row.connector_id as string,
    connectorType: row.connector_type as string,
    externalId: row.external_id as string,
    subscriptionId: row.subscription_id as string,
    channelToken: row.channel_token as string,
    expiresAt: row.expires_at ? (row.expires_at as Date).toISOString() : null,
    createdAt: (row.created_at as Date).toISOString(),
  }
}

export async function listByTenant(tenantId: string): Promise<KnowledgeItem[]> {
  return withTenantScope(tenantId, async (client) => {
    const result = await client.query(
      `SELECT * FROM knowledge_items WHERE tenant_id = $1 ORDER BY created_at DESC`,
      [tenantId],
    )
    return result.rows.map(mapRow)
  })
}

export async function findById(id: string, tenantId: string): Promise<KnowledgeItem | null> {
  return withTenantScope(tenantId, async (client) => {
    const result = await client.query(
      `SELECT * FROM knowledge_items WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    )
    return result.rows[0] ? mapRow(result.rows[0]) : null
  })
}

export async function findByExternalId(
  tenantId: string,
  connectorId: string,
  externalId: string,
): Promise<KnowledgeItem | null> {
  return withTenantScope(tenantId, async (client) => {
    const result = await client.query(
      `SELECT * FROM knowledge_items WHERE tenant_id = $1 AND connector_id = $2 AND external_id = $3`,
      [tenantId, connectorId, externalId],
    )
    return result.rows[0] ? mapRow(result.rows[0]) : null
  })
}

export async function findByParentId(tenantId: string, parentId: string): Promise<KnowledgeItem[]> {
  return withTenantScope(tenantId, async (client) => {
    const result = await client.query(
      `SELECT * FROM knowledge_items WHERE tenant_id = $1 AND parent_id = $2 ORDER BY created_at ASC`,
      [tenantId, parentId],
    )
    return result.rows.map(mapRow)
  })
}

export async function deleteByParentId(tenantId: string, parentId: string): Promise<void> {
  await withTenantScope(tenantId, async (client) => {
    await client.query(
      `DELETE FROM knowledge_items WHERE tenant_id = $1 AND parent_id = $2`,
      [tenantId, parentId],
    )
  })
}

/** How many times the backstop retries one item before leaving it alone. */
export const MAX_EXTRACTION_ATTEMPTS = 5

// Work the batch should pick up: anything never attempted, plus anything that
// failed, is inside its attempt budget, and has waited out its backoff. The
// second half is new — the batch called itself a backstop for two months
// while selecting only 'pending', so an item that errored once was done for
// good (migration 357).
//
// Backoff doubles from 15 minutes, so a file that cannot be read costs 5
// requests over about 8 hours rather than one every 5 minutes forever.
const EXTRACTION_DUE_PREDICATE = `(
  extraction_status = 'pending'
  OR (
    extraction_status = 'error'
    AND extraction_attempts < ${MAX_EXTRACTION_ATTEMPTS}
    AND updated_at < NOW() - (INTERVAL '15 minutes' * POWER(2, extraction_attempts))
  )
)`

export async function findPendingExtraction(tenantId?: string, limit = 50): Promise<KnowledgeItem[]> {
  if (tenantId) {
    return withTenantScope(tenantId, async (client) => {
      const result = await client.query(
        `SELECT * FROM knowledge_items
         WHERE tenant_id = $1 AND ${EXTRACTION_DUE_PREDICATE}
         ORDER BY created_at ASC LIMIT $2`,
        [tenantId, limit],
      )
      return result.rows.map(mapRow)
    })
  }
  // Cross-tenant scan invoked from the extraction batch job. Admin scope is
  // intentional — the job processes pending items across all tenants.
  return withAdminScope(
    { caller: 'knowledge.findPendingExtraction', reason: 'cross-tenant pending-extraction scan' },
    async (client) => {
      const result = await client.query(
        `SELECT * FROM knowledge_items
         WHERE ${EXTRACTION_DUE_PREDICATE}
         ORDER BY created_at ASC LIMIT $1`,
        [limit],
      )
      return result.rows.map(mapRow)
    },
  )
}

export interface KnowledgeSearchResult {
  id: string
  title: string
  excerpt: string | null
  sourceUrl: string | null
  connectorId: string | null
  connectorType: string | null
  rank: number
}

function mapSearchRow(row: Record<string, unknown>): KnowledgeSearchResult {
  return {
    id: row.id as string,
    title: row.title as string,
    excerpt: (row.excerpt as string | null) ?? null,
    sourceUrl: (row.source_url as string | null) ?? null,
    connectorId: (row.connector_id as string | null) ?? null,
    connectorType: (row.connector_type as string | null) ?? null,
    rank: Number(row.rank),
  }
}

/**
 * Full-text search over a tenant's knowledge_items, scoped to a list of
 * connector UUIDs (from the calling agent's IntegrationPermission[]).
 * Title-only matches are allowed; ts_headline backfills an excerpt when
 * the native excerpt is empty.
 *
 * When `queryEmbedding` is supplied, the result set is a Reciprocal Rank
 * Fusion of BM25 and cosine similarity. The tool signature at the call
 * site is unchanged.
 */
export async function searchByTenantAndConnectors(
  tenantId: string,
  connectorIds: string[],
  includeManual: boolean,
  query: string,
  limit: number,
  queryEmbedding?: number[],
  pinnedIds: string[] = [],
): Promise<KnowledgeSearchResult[]> {
  return withTenantScope(tenantId, async (client) => {
    if (queryEmbedding && queryEmbedding.length > 0) {
      const vectorLiteral = `[${queryEmbedding.join(',')}]`
      // Two read paths, gated by env vars to allow staged rollout:
      //   KNOWLEDGE_CHUNK_READ=true  → Phase 3 per-chunk join (best excerpt)
      //   KNOWLEDGE_CHUNK_READ=false → Phase 2 per-item embedding_v2 or v1
      //   KNOWLEDGE_EMBEDDING_V2_READ=true → use embedding_v2 vs embedding
      // At deploy: chunks are empty (worker hasn't backfilled yet), so default
      // both flags off → reads embedding (v1). Operator flips V2_READ after v2
      // backfill, then CHUNK_READ once knowledge_item_chunks is populated.
      const readsChunks = process.env.KNOWLEDGE_CHUNK_READ === 'true'
      const readsV2 = process.env.KNOWLEDGE_EMBEDDING_V2_READ === 'true'
      const embCol = readsV2 ? 'embedding_v2' : 'embedding'
      // Cosine-distance floor on the vec CTE: pgvector's `<=>` returns values
      // in [0, 2]. Anything past ~0.7 is effectively unrelated content. Without
      // this filter, a tiny corpus (≤50 items) would have every row contribute
      // to the RRF fused score, letting semantically-loose documents outrank
      // tight keyword hits.
      if (readsChunks) {
        const result = await client.query(
          `WITH bm25 AS (
             SELECT id AS item_id,
                    row_number() OVER (ORDER BY ts_rank_cd(search_tsv, q) DESC) AS rk
               FROM knowledge_items, websearch_to_tsquery('english', $1) q
              WHERE tenant_id = $2
                AND sync_status = 'synced'
                AND search_tsv @@ q
                AND (connector_id = ANY($3::uuid[])
                  OR (connector_id IS NULL AND $4::boolean)
                  OR id = ANY($7::uuid[]))  -- pinned bypass scoping gate
              LIMIT 50
           ),
           -- Pinned BM25 matches that fell BELOW the LIMIT 50 cutoff but still match
           -- the query. UNIONed into the candidate pool so a barely-matching pin
           -- isn't pruned before is_pinned DESC ordering can elevate it.
           pinned_bm25_overflow AS (
             SELECT id AS item_id,
                    row_number() OVER (ORDER BY ts_rank_cd(search_tsv, q) DESC) + 50 AS rk
               FROM knowledge_items, websearch_to_tsquery('english', $1) q
              WHERE tenant_id = $2 AND sync_status = 'synced' AND search_tsv @@ q
                AND id = ANY($7::uuid[])
                AND id NOT IN (SELECT item_id FROM bm25)
           ),
           vec AS (
             SELECT c.item_id, c.text AS chunk_text,
                    row_number() OVER (ORDER BY c.embedding <=> $6::vector ASC) AS rk
               FROM knowledge_item_chunks c
               JOIN knowledge_items k ON k.id = c.item_id
              WHERE k.tenant_id = $2 AND k.sync_status = 'synced'
                AND c.embedding IS NOT NULL AND c.embedding <=> $6::vector < 0.7
                AND (k.connector_id = ANY($3::uuid[])
                  OR (k.connector_id IS NULL AND $4::boolean)
                  OR k.id = ANY($7::uuid[]))
              ORDER BY c.embedding <=> $6::vector ASC LIMIT 50
           ),
           pinned_vec_overflow AS (
             SELECT c.item_id, c.text AS chunk_text,
                    row_number() OVER (ORDER BY c.embedding <=> $6::vector ASC) + 50 AS rk
               FROM knowledge_item_chunks c
               JOIN knowledge_items k ON k.id = c.item_id
              WHERE k.tenant_id = $2 AND k.sync_status = 'synced'
                AND c.embedding IS NOT NULL AND c.embedding <=> $6::vector < 0.7
                AND k.id = ANY($7::uuid[])
                AND k.id NOT IN (SELECT item_id FROM vec)
           ),
           fused AS (
             SELECT item_id,
                    MAX(chunk_text) AS best_chunk,
                    SUM(1.0 / (60.0 + rk)) AS score,
                    bool_or(item_id = ANY($7::uuid[])) AS is_pinned
               FROM (
                 SELECT item_id, NULL::text AS chunk_text, rk FROM bm25
                 UNION ALL
                 SELECT item_id, chunk_text, rk FROM vec
                 UNION ALL
                 SELECT item_id, NULL::text AS chunk_text, rk FROM pinned_bm25_overflow
                 UNION ALL
                 SELECT item_id, chunk_text, rk FROM pinned_vec_overflow
               ) u
              GROUP BY item_id
           )
           -- Promoted-Results ordering: pinned matches first (sorted by their own
           -- RRF score), then natural matches (sorted by RRF). No multiplier needed.
           SELECT k.id, k.title, k.source_url, k.connector_id, k.connector_type,
                  COALESCE(
                    f.best_chunk,
                    NULLIF(k.excerpt, ''),
                    ts_headline('english', COALESCE(k.extracted_text, k.title),
                                websearch_to_tsquery('english', $1),
                                'MaxFragments=2, MaxWords=20, MinWords=5')
                  ) AS excerpt,
                  f.score AS rank
             FROM fused f JOIN knowledge_items k ON k.id = f.item_id
            ORDER BY f.is_pinned DESC, f.score DESC LIMIT $5`,
          [query, tenantId, connectorIds, includeManual, limit, vectorLiteral, pinnedIds],
        )
        return result.rows.map(mapSearchRow)
      }
      // Phase 2 per-item read path
      const result = await client.query(
        `WITH bm25 AS (
           SELECT id,
                  row_number() OVER (ORDER BY ts_rank_cd(search_tsv, q) DESC) AS rk
             FROM knowledge_items, websearch_to_tsquery('english', $1) q
            WHERE tenant_id = $2
              AND sync_status = 'synced'
              AND search_tsv @@ q
              AND (connector_id = ANY($3::uuid[])
                OR (connector_id IS NULL AND $4::boolean)
                OR id = ANY($7::uuid[]))
            LIMIT 50
         ),
         pinned_bm25_overflow AS (
           SELECT id,
                  row_number() OVER (ORDER BY ts_rank_cd(search_tsv, q) DESC) + 50 AS rk
             FROM knowledge_items, websearch_to_tsquery('english', $1) q
            WHERE tenant_id = $2 AND sync_status = 'synced' AND search_tsv @@ q
              AND id = ANY($7::uuid[])
              AND id NOT IN (SELECT id FROM bm25)
         ),
         vec AS (
           SELECT id,
                  row_number() OVER (ORDER BY ${embCol} <=> $6::vector ASC) AS rk
             FROM knowledge_items
            WHERE tenant_id = $2
              AND sync_status = 'synced'
              AND ${embCol} IS NOT NULL
              AND ${embCol} <=> $6::vector < 0.7
              AND (connector_id = ANY($3::uuid[])
                OR (connector_id IS NULL AND $4::boolean)
                OR id = ANY($7::uuid[]))
            ORDER BY ${embCol} <=> $6::vector ASC
            LIMIT 50
         ),
         pinned_vec_overflow AS (
           SELECT id,
                  row_number() OVER (ORDER BY ${embCol} <=> $6::vector ASC) + 50 AS rk
             FROM knowledge_items
            WHERE tenant_id = $2 AND sync_status = 'synced'
              AND ${embCol} IS NOT NULL AND ${embCol} <=> $6::vector < 0.7
              AND id = ANY($7::uuid[])
              AND id NOT IN (SELECT id FROM vec)
         ),
         fused AS (
           SELECT id,
                  SUM(1.0 / (60.0 + rk)) AS score,
                  bool_or(id = ANY($7::uuid[])) AS is_pinned
             FROM (
               SELECT id, rk FROM bm25
               UNION ALL SELECT id, rk FROM vec
               UNION ALL SELECT id, rk FROM pinned_bm25_overflow
               UNION ALL SELECT id, rk FROM pinned_vec_overflow
             ) u
            GROUP BY id
         )
         SELECT k.id, k.title, k.source_url, k.connector_id, k.connector_type,
                COALESCE(NULLIF(k.excerpt, ''),
                         ts_headline('english', COALESCE(k.extracted_text, k.title),
                                     websearch_to_tsquery('english', $1),
                                     'MaxFragments=2, MaxWords=20, MinWords=5')) AS excerpt,
                f.score AS rank
           FROM fused f JOIN knowledge_items k ON k.id = f.id
          ORDER BY f.is_pinned DESC, f.score DESC LIMIT $5`,
        [query, tenantId, connectorIds, includeManual, limit, vectorLiteral, pinnedIds],
      )
      return result.rows.map(mapSearchRow)
    }

    const result = await client.query(
      `WITH matches AS (
         SELECT id, title, source_url, connector_id, connector_type,
                COALESCE(
                  NULLIF(excerpt, ''),
                  ts_headline('english', COALESCE(extracted_text, title), q,
                              'MaxFragments=2, MaxWords=20, MinWords=5')
                ) AS excerpt,
                ts_rank_cd(search_tsv, q) AS rank,
                (id = ANY($6::uuid[])) AS is_pinned
           FROM knowledge_items, websearch_to_tsquery('english', $1) AS q
          WHERE tenant_id = $2
            AND sync_status = 'synced'
            AND search_tsv @@ q
            AND (
              connector_id = ANY($3::uuid[])
              OR (connector_id IS NULL AND $4::boolean)
              -- Pinned items bypass the connector scoping gate so a relevant
              -- pin always reaches \`matches\`, even if (race) its connector
              -- was unbound between save and search. Save-time §1.7 filters
              -- orphans into pinned_knowledge_ids; this is belt-and-braces.
              OR id = ANY($6::uuid[])
            )
       )
       SELECT id, title, source_url, connector_id, connector_type, excerpt, rank
         FROM matches
        -- is_pinned DESC puts every pinned match above every non-pinned;
        -- rank DESC orders within each group by natural relevance.
        ORDER BY is_pinned DESC, rank DESC
        LIMIT $5`,
      [query, tenantId, connectorIds, includeManual, limit, pinnedIds],
    )
    return result.rows.map(mapSearchRow)
  })
}

/** Count items the agent's bindings can see. Drives tool-exposure gating. */
export async function countByTenantAndConnectors(
  tenantId: string,
  connectorIds: string[],
  includeManual: boolean,
): Promise<number> {
  return withTenantScope(tenantId, async (client) => {
    const result = await client.query(
      `SELECT count(*)::int AS n
         FROM knowledge_items
        WHERE tenant_id = $1
          AND sync_status = 'synced'
          AND (
            connector_id = ANY($2::uuid[])
            OR (connector_id IS NULL AND $3::boolean)
          )`,
      [tenantId, connectorIds, includeManual],
    )
    return result.rows[0]?.n ?? 0
  })
}

/**
 * Every synced knowledge item this tenant has, regardless of which connector
 * (if any) produced it.
 *
 * Deliberately NOT scoped by connector id, unlike countByTenantAndConnectors:
 * connector ids belong to connector-service (ADR-049), and the data landscape
 * asks what the workspace holds rather than what one agent's bindings reach.
 * Scoping it would report a number smaller than the truth and label it as the
 * truth.
 */
export async function countAllByTenant(tenantId: string): Promise<number> {
  return withTenantScope(tenantId, async (client) => {
    const result = await client.query(
      `SELECT count(*)::int AS n
         FROM knowledge_items
        WHERE tenant_id = $1
          AND sync_status = 'synced'`,
      [tenantId],
    )
    return result.rows[0]?.n ?? 0
  })
}

export async function markExtracting(tenantId: string, id: string): Promise<void> {
  await withTenantScope(tenantId, async (client) => {
    await client.query(
      `UPDATE knowledge_items SET extraction_status = 'extracting', updated_at = NOW() WHERE id = $1`,
      [id],
    )
  })
}

export async function saveExtractedText(tenantId: string, id: string, text: string): Promise<void> {
  await withTenantScope(tenantId, async (client) => {
    // Embedding invalidation on text change is handled by a DB trigger
    // installed by migration 232 (knowledge_items_invalidate_embedding_trg).
    // Keeping the trigger in the database means this code path does not need
    // to know that the embedding column exists, so Phase 1 (extraction) and
    // Phase 3 (embeddings) can roll forward/back independently.
    await client.query(
      `UPDATE knowledge_items
       SET extracted_text = $2, extraction_status = 'done', extracted_at = NOW(),
           extraction_attempts = 0, updated_at = NOW()
       WHERE id = $1`,
      [id, text],
    )
  })
}

export async function markExtractionError(tenantId: string, id: string, error: string): Promise<void> {
  await withTenantScope(tenantId, async (client) => {
    await client.query(
      `UPDATE knowledge_items
       SET extraction_status = 'error', sync_error = $2,
           extraction_attempts = extraction_attempts + 1, updated_at = NOW()
       WHERE id = $1`,
      [id, error],
    )
  })
}

export async function updateMetadataField(tenantId: string, id: string, key: string, value: unknown): Promise<void> {
  const patch = JSON.stringify({ [key]: value })
  await withTenantScope(tenantId, async (client) => {
    await client.query(
      `UPDATE knowledge_items SET metadata = metadata || $2::jsonb, updated_at = NOW() WHERE id = $1`,
      [id, patch],
    )
  })
}

export async function create(
  tenantId: string,
  input: CreateKnowledgeItemInput,
): Promise<{ item: KnowledgeItem; outboxRef: OutboxRowRef | null }> {
  return withTenantScope(tenantId, async (client) => {
    const result = await client.query(
      `INSERT INTO knowledge_items
         (tenant_id, title, source_url, connector_id, connector_type, external_id,
          content_type, excerpt, metadata, import_mode, sync_status, last_synced_at,
          parent_id, extraction_status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
       RETURNING *`,
      [
        tenantId,
        input.title,
        input.sourceUrl ?? null,
        input.connectorId ?? null,
        input.connectorType ?? null,
        input.externalId ?? null,
        input.contentType,
        input.excerpt ?? null,
        JSON.stringify(input.metadata ?? {}),
        input.importMode ?? 'manual',
        'synced',
        new Date(),
        input.parentId ?? null,
        input.extractionStatus ?? 'none',
      ],
    )
    const item = mapRow(result.rows[0])
    // Only enqueue when extraction is actually needed. Folders, collections,
    // and items with prior 'done' status (re-imports) skip event publish.
    const outboxRef = item.extractionStatus === 'pending'
      ? await enqueueKnowledgeOutbox(client, {
          tenantId,
          itemId: item.id,
          eventType: 'knowledge.items.created',
          entityVersion: null,
          payload: { tenantId, itemId: item.id },
        })
      : null
    return { item, outboxRef }
  })
}

export async function batchCreate(
  tenantId: string,
  items: CreateKnowledgeItemInput[],
): Promise<{ items: KnowledgeItem[]; outboxRefs: OutboxRowRef[] }> {
  if (items.length === 0) return { items: [], outboxRefs: [] }

  // Build parameterized batch INSERT with ON CONFLICT DO UPDATE to handle
  // re-imports of the same external ID (upsert by tenant+connector+external_id).
  const values: unknown[] = []
  const rows = items.map((item, i) => {
    const base = i * 14
    values.push(
      tenantId,
      item.title,
      item.sourceUrl ?? null,
      item.connectorId ?? null,
      item.connectorType ?? null,
      item.externalId ?? null,
      item.contentType,
      item.excerpt ?? null,
      JSON.stringify(item.metadata ?? {}),
      item.importMode ?? 'manual',
      'synced',
      new Date(),
      item.parentId ?? null,
      item.extractionStatus ?? 'none',
    )
    return `($${base + 1},$${base + 2},$${base + 3},$${base + 4},$${base + 5},$${base + 6},$${base + 7},$${base + 8},$${base + 9},$${base + 10},$${base + 11},$${base + 12},$${base + 13},$${base + 14})`
  })

  return withTenantScope(tenantId, async (client) => {
    const result = await client.query(
      `INSERT INTO knowledge_items
         (tenant_id, title, source_url, connector_id, connector_type, external_id,
          content_type, excerpt, metadata, import_mode, sync_status, last_synced_at,
          parent_id, extraction_status)
       VALUES ${rows.join(', ')}
       ON CONFLICT (tenant_id, connector_id, external_id)
         WHERE connector_id IS NOT NULL AND external_id IS NOT NULL
       DO UPDATE SET
         title             = EXCLUDED.title,
         source_url        = EXCLUDED.source_url,
         excerpt           = EXCLUDED.excerpt,
         metadata          = EXCLUDED.metadata,
         parent_id         = EXCLUDED.parent_id,
         extraction_status = CASE
           WHEN knowledge_items.extraction_status = 'done' THEN 'done'
           ELSE EXCLUDED.extraction_status
         END,
         sync_status       = 'synced',
         last_synced_at    = NOW(),
         updated_at        = NOW()
       RETURNING *`,
      values,
    )
    const created = result.rows.map(mapRow)
    // Enqueue one outbox row per item that is in 'pending' extraction state
    // post-upsert. UPSERT branch may flip extraction_status back to 'pending'
    // for a resync — those need new events too. Skip items that are 'done'
    // (UPSERT preserved them) and 'none' (folders/collections — no work).
    const outboxRefs: OutboxRowRef[] = []
    for (const item of created) {
      if (item.extractionStatus !== 'pending') continue
      const ref = await enqueueKnowledgeOutbox(client, {
        tenantId,
        itemId: item.id,
        eventType: 'knowledge.items.created',
        entityVersion: null,
        payload: { tenantId, itemId: item.id },
      })
      outboxRefs.push(ref)
    }
    return { items: created, outboxRefs }
  })
}

/**
 * The library item whose CONTENT is nearest to a candidate, when it is near
 * enough to count as the same document (P1.1 absorption dedup).
 *
 * Title matching alone cannot see that "Refund Policy.md" and
 * "refunds-policy-v2.md" are one document; this can. Only items that have
 * already been embedded are comparable — a freshly imported item has no
 * embedding until the extraction worker runs — so the caller keeps its title
 * check as the fast path for the common re-import case.
 *
 * `maxDistance` is pgvector cosine distance (`<=>`, 0 = identical).
 */
export async function findNearestByEmbedding(
  tenantId: string,
  embedding: number[],
  maxDistance: number,
): Promise<{ id: string; title: string; distance: number } | null> {
  if (embedding.length === 0) return null
  return withTenantScope(tenantId, async (client) => {
    const result = await client.query<{ id: string; title: string; distance: string }>(
      `SELECT id, title, (embedding <=> $2::vector) AS distance
         FROM knowledge_items
        WHERE tenant_id = $1
          AND embedding IS NOT NULL
          AND (embedding <=> $2::vector) <= $3
        ORDER BY embedding <=> $2::vector
        LIMIT 1`,
      [tenantId, `[${embedding.join(',')}]`, maxDistance],
    )
    const row = result.rows[0]
    return row ? { id: row.id, title: row.title, distance: Number(row.distance) } : null
  })
}

export async function update(
  id: string,
  tenantId: string,
  input: Partial<CreateKnowledgeItemInput>,
): Promise<KnowledgeItem | null> {
  return withTenantScope(tenantId, async (client) => {
    const result = await client.query(
      `UPDATE knowledge_items SET
         title          = COALESCE($3, title),
         source_url     = COALESCE($4, source_url),
         connector_id   = COALESCE($5, connector_id),
         connector_type = COALESCE($6, connector_type),
         external_id    = COALESCE($7, external_id),
         content_type   = COALESCE($8, content_type),
         excerpt        = COALESCE($9, excerpt),
         metadata       = CASE WHEN $10::jsonb IS NOT NULL THEN $10::jsonb ELSE metadata END,
         import_mode    = COALESCE($11, import_mode),
         updated_at     = NOW()
       WHERE id = $1 AND tenant_id = $2
       RETURNING *`,
      [
        id,
        tenantId,
        input.title ?? null,
        input.sourceUrl ?? null,
        input.connectorId ?? null,
        input.connectorType ?? null,
        input.externalId ?? null,
        input.contentType ?? null,
        input.excerpt ?? null,
        input.metadata ? JSON.stringify(input.metadata) : null,
        input.importMode ?? null,
      ],
    )
    return result.rows[0] ? mapRow(result.rows[0]) : null
  })
}

export async function remove(id: string, tenantId: string): Promise<boolean> {
  return withTenantScope(tenantId, async (client) => {
    const result = await client.query(
      `DELETE FROM knowledge_items WHERE id = $1 AND tenant_id = $2`,
      [id, tenantId],
    )
    return (result.rowCount ?? 0) > 0
  })
}

/**
 * Delete every knowledge item imported from one connector.
 *
 * This is the cleanup a FK CASCADE would have given us if `connector_id`
 * pointed at a table in this database. It does not — connector rows live in
 * connector-service's own database (migration 356, ADR-049) — so the delete
 * runs off the `connector.deleted` event instead. Chunks and outbox rows
 * cascade from `knowledge_items` (migrations 238 / 240), so this one statement
 * is the whole cleanup.
 *
 * Returns the number of items deleted.
 */
export async function removeByConnector(
  tenantId: string,
  connectorId: string,
): Promise<number> {
  return withTenantScope(tenantId, async (client) => {
    const result = await client.query(
      `DELETE FROM knowledge_items WHERE tenant_id = $1 AND connector_id = $2`,
      [tenantId, connectorId],
    )
    return result.rowCount ?? 0
  })
}

export async function listByConnector(
  tenantId: string,
  connectorId: string,
): Promise<KnowledgeItem[]> {
  return withTenantScope(tenantId, async (client) => {
    const result = await client.query(
      `SELECT * FROM knowledge_items WHERE tenant_id = $1 AND connector_id = $2 ORDER BY created_at DESC`,
      [tenantId, connectorId],
    )
    return result.rows.map(mapRow)
  })
}

export async function markSynced(ids: string[], tenantId: string): Promise<number> {
  if (ids.length === 0) return 0
  const placeholders = ids.map((_, i) => `$${i + 2}`).join(', ')
  return withTenantScope(tenantId, async (client) => {
    const result = await client.query(
      `UPDATE knowledge_items
       SET sync_status = 'synced', last_synced_at = NOW(), sync_error = NULL, updated_at = NOW()
       WHERE tenant_id = $1 AND id IN (${placeholders})`,
      [tenantId, ...ids],
    )
    return result.rowCount ?? 0
  })
}

export async function markSyncError(
  id: string,
  tenantId: string,
  error: string,
): Promise<void> {
  await withTenantScope(tenantId, async (client) => {
    await client.query(
      `UPDATE knowledge_items
       SET sync_status = 'error', sync_error = $3, last_synced_at = NOW(), updated_at = NOW()
       WHERE tenant_id = $1 AND id = $2`,
      [tenantId, id, error],
    )
  })
}

// ── Webhook subscription helpers ─────────────────────────────────────────────

export async function upsertWebhookSubscription(sub: Omit<KnowledgeWebhookSubscription, 'id' | 'createdAt'>): Promise<KnowledgeWebhookSubscription> {
  return withTenantScope(sub.tenantId, async (client) => {
    const result = await client.query(
      `INSERT INTO knowledge_webhook_subscriptions
         (tenant_id, connector_id, connector_type, external_id, subscription_id, channel_token, expires_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (connector_id, external_id) DO UPDATE SET
         subscription_id = EXCLUDED.subscription_id,
         channel_token   = EXCLUDED.channel_token,
         expires_at      = EXCLUDED.expires_at
       RETURNING *`,
      [sub.tenantId, sub.connectorId, sub.connectorType, sub.externalId, sub.subscriptionId, sub.channelToken, sub.expiresAt ?? null],
    )
    return mapWebhookRow(result.rows[0])
  })
}

// Webhook callbacks arrive from external providers without tenant context;
// the only routable key is the channel token / subscription_id / connector
// identifier. These lookups must run in admin scope so the calling webhook
// router can resolve the row and then continue under the row's tenant.
export async function findWebhookByToken(channelToken: string): Promise<KnowledgeWebhookSubscription | null> {
  return withAdminScope(
    { caller: 'knowledge.findWebhookByToken', reason: 'resolve webhook tenant from inbound channel token' },
    async (client) => {
      const result = await client.query(
        `SELECT * FROM knowledge_webhook_subscriptions WHERE channel_token = $1`,
        [channelToken],
      )
      return result.rows[0] ? mapWebhookRow(result.rows[0]) : null
    },
  )
}

export async function findExpiringWebhooks(withinHours = 48): Promise<KnowledgeWebhookSubscription[]> {
  // Background renewal job — cross-tenant scan.
  return withAdminScope(
    { caller: 'knowledge.findExpiringWebhooks', reason: 'cross-tenant webhook renewal scan' },
    async (client) => {
      const result = await client.query(
        `SELECT * FROM knowledge_webhook_subscriptions
         WHERE expires_at IS NOT NULL AND expires_at < NOW() + (INTERVAL '1 hour' * $1)
         ORDER BY expires_at ASC`,
        [withinHours],
      )
      return result.rows.map(mapWebhookRow)
    },
  )
}

export async function deleteWebhookSubscription(tenantId: string, connectorId: string, externalId: string): Promise<void> {
  await withTenantScope(tenantId, async (client) => {
    await client.query(
      `DELETE FROM knowledge_webhook_subscriptions WHERE connector_id = $1 AND external_id = $2`,
      [connectorId, externalId],
    )
  })
}

export async function findWebhookByExternalId(tenantId: string, connectorId: string, externalId: string): Promise<KnowledgeWebhookSubscription | null> {
  return withTenantScope(tenantId, async (client) => {
    const result = await client.query(
      `SELECT * FROM knowledge_webhook_subscriptions WHERE connector_id = $1 AND external_id = $2`,
      [connectorId, externalId],
    )
    return result.rows[0] ? mapWebhookRow(result.rows[0]) : null
  })
}

export async function findWebhooksByConnector(tenantId: string, connectorId: string): Promise<KnowledgeWebhookSubscription[]> {
  return withTenantScope(tenantId, async (client) => {
    const result = await client.query(
      `SELECT * FROM knowledge_webhook_subscriptions WHERE tenant_id = $1 AND connector_id = $2`,
      [tenantId, connectorId],
    )
    return result.rows.map(mapWebhookRow)
  })
}

export async function findWebhookBySubscriptionId(subscriptionId: string): Promise<KnowledgeWebhookSubscription | null> {
  return withAdminScope(
    { caller: 'knowledge.findWebhookBySubscriptionId', reason: 'resolve webhook tenant from inbound subscription id' },
    async (client) => {
      const result = await client.query(
        `SELECT * FROM knowledge_webhook_subscriptions WHERE subscription_id = $1`,
        [subscriptionId],
      )
      return result.rows[0] ? mapWebhookRow(result.rows[0]) : null
    },
  )
}

export async function findByIds(
  tenantId: string,
  ids: string[],
): Promise<Array<{
  id: string;
  title: string;
  sourceUrl: string | null;
  connectorId: string | null;
}>> {
  if (!ids.length) return []
  return withTenantScope(tenantId, async (client) => {
    const result = await client.query(
      `SELECT id, title, source_url, connector_id FROM knowledge_items WHERE tenant_id = $1 AND id = ANY($2)`,
      [tenantId, ids],
    )
    return result.rows.map((row: Record<string, unknown>) => ({
      id: row.id as string,
      title: row.title as string,
      sourceUrl: (row.source_url as string | null) ?? null,
      connectorId: (row.connector_id as string | null) ?? null,
    }))
  })
}
