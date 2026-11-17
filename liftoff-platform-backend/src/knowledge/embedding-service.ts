// Knowledge Item Embedding Pipeline
//
// Generates per-chunk embedding vectors for knowledge_items rows so
// corpus_search can layer Reciprocal Rank Fusion on top of tsvector full-text
// search AND surface the matched paragraph as the result excerpt. Multi-
// provider via @liftoffos/embedding (Google default, OpenAI/Voyage available).
//
// Worker scans knowledge_items synced rows that have no entry in
// knowledge_item_chunks. Invalidation on resync is handled by the DB trigger
// (migration 232 → 237 → 238 → 240) which deletes chunk rows when
// extracted_text changes.

import { withTenantScope, withAdminScope } from '../infrastructure/database'
import { log } from '../infrastructure/logging'
import { embeddingClient } from '@liftoffos/embedding'

const CHUNK_CHAR_BUDGET = 4000
// Pinned to match knowledge_item_chunks.embedding vector(768).
// All three providers can produce 768d vectors via Matryoshka truncation:
//   - google gemini-embedding-001: native 3072d → truncated to 768d (best quality)
//   - openai text-embedding-3-small: native 1536d → truncated to 768d (via dimensions param)
//   - voyage voyage-4: native 1024d → truncated to 768d (via output_dimension)
const STORAGE_DIMENSIONS = 768

function chunkText(text: string): string[] {
  if (text.length <= CHUNK_CHAR_BUDGET) return [text]
  const chunks: string[] = []
  for (let i = 0; i < text.length; i += CHUNK_CHAR_BUDGET) {
    chunks.push(text.slice(i, i + CHUNK_CHAR_BUDGET))
  }
  return chunks
}

function averageVectors(vectors: number[][]): number[] {
  if (vectors.length === 0) {
    throw new Error('averageVectors received an empty input — provider returned no embeddings')
  }
  if (vectors.length === 1) return vectors[0]
  const out = new Array(vectors[0].length).fill(0)
  for (const v of vectors) for (let i = 0; i < v.length; i++) out[i] += v[i]
  for (let i = 0; i < out.length; i++) out[i] /= vectors.length
  return out
}

function vectorLiteral(vec: number[]): string {
  return `[${vec.join(',')}]`
}

/** Embed a search query. Used by /api/internal/knowledge/search. Caller
 *  supplies agent attribution so the llm_usage_log row carries it. */
export async function embedQuery(
  query: string,
  attribution: {
    tenantId: string
    agentId?: string
    sessionId?: string
    threadId?: string
    invocationId?: string
  },
): Promise<number[] | null> {
  try {
    const response = await embeddingClient.embed({
      input: query.slice(0, CHUNK_CHAR_BUDGET),
      dimensions: STORAGE_DIMENSIONS,
      // Asymmetric retrieval: tag this as the query side. Providers that
      // support it (Google, Voyage) produce measurably better cosine scores
      // when query/document use the right hint.
      taskType: 'retrieval_query',
      context: {
        ...Object.fromEntries(
          Object.entries(attribution).filter(([, v]) => v !== undefined),
        ) as Record<string, string>,
        purpose: 'knowledge_embedding_query',
      },
    })
    return response.embeddings[0]
  } catch {
    // embeddingClient already wrote the failure row via onUsage; caller falls back to BM25.
    return null
  }
}

interface PendingRow { id: string; tenantId: string; text: string }

// Pending criterion: anything synced that has no chunks yet OR no per-item
// embedding_v2 yet. The trigger from migration 238 deletes chunks AND nulls
// embedding_v2 on extracted_text edit, so the same predicate catches both
// first-time inserts and post-edit re-embeds for either storage path.
// Dual-write lets retrieval fall back to per-item averaging if chunks aren't
// yet populated (operator hasn't flipped KNOWLEDGE_CHUNK_READ).
async function findPendingForEmbedding(limit: number): Promise<PendingRow[]> {
  return withAdminScope(
    { caller: 'knowledge.findPendingForEmbedding', reason: 'cross-tenant embedding worker scan' },
    async (client) => {
      const r = await client.query(
        `SELECT id, tenant_id, extracted_text
           FROM knowledge_items
          WHERE (
              embedding_v2 IS NULL
              OR NOT EXISTS (
                SELECT 1 FROM knowledge_item_chunks c WHERE c.item_id = knowledge_items.id
              )
            )
            AND extracted_text IS NOT NULL
            AND extracted_text <> ''
            AND sync_status = 'synced'
          ORDER BY created_at ASC
          LIMIT $1`,
        [limit],
      )
      return r.rows.map((row: Record<string, unknown>) => ({
        id: row.id as string,
        tenantId: row.tenant_id as string,
        text: row.extracted_text as string,
      }))
    },
  )
}

async function writeItemEmbedding(tenantId: string, id: string, vec: number[]): Promise<void> {
  await withTenantScope(tenantId, async (client) => {
    await client.query(
      `UPDATE knowledge_items SET embedding_v2 = $2::vector, updated_at = NOW() WHERE id = $1`,
      [id, vectorLiteral(vec)],
    )
  })
}

async function writeChunks(
  tenantId: string,
  itemId: string,
  texts: string[],
  vectors: number[][],
  embeddingProvider: string,
  embeddingModel: string,
): Promise<void> {
  await withTenantScope(tenantId, async (client) => {
    await client.query(`DELETE FROM knowledge_item_chunks WHERE item_id = $1`, [itemId])
    if (texts.length === 0) return
    const values: unknown[] = []
    const rows = texts.map((text, i) => {
      const base = i * 7
      values.push(itemId, tenantId, i, text, vectorLiteral(vectors[i]), embeddingProvider, embeddingModel)
      return `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}::vector, $${base + 6}, $${base + 7})`
    })
    await client.query(
      `INSERT INTO knowledge_item_chunks (item_id, tenant_id, chunk_index, text, embedding, embedding_provider, embedding_model)
       VALUES ${rows.join(', ')}`,
      values,
    )
  })
}

// New: per-item embed. Idempotent — writeChunks does DELETE+INSERT, and
// writeItemEmbedding is an UPDATE. Safe under at-least-once retry.
// Returns { embedded: false } when the item has no extracted_text (caller
// should retry after extraction lands).
export async function embedItem(tenantId: string, itemId: string): Promise<{ embedded: boolean }> {
  const row = await withTenantScope(tenantId, async (client) => {
    const r = await client.query(
      `SELECT id, tenant_id, extracted_text
         FROM knowledge_items
        WHERE id = $1
          AND extracted_text IS NOT NULL
          AND extracted_text <> ''
          AND sync_status = 'synced'`,
      [itemId],
    )
    if (r.rows.length === 0) return null
    return {
      id: r.rows[0].id as string,
      tenantId: r.rows[0].tenant_id as string,
      text: r.rows[0].extracted_text as string,
    }
  })
  if (!row) return { embedded: false }

  try {
    const chunks = chunkText(row.text)
    const response = await embeddingClient.embed({
      input: chunks,
      dimensions: STORAGE_DIMENSIONS,
      taskType: 'retrieval_document',
      context: { tenantId: row.tenantId, purpose: 'knowledge_embedding', itemId: row.id },
    })
    await writeChunks(row.tenantId, row.id, chunks, response.embeddings, response.provider, response.model)
    await writeItemEmbedding(row.tenantId, row.id, averageVectors(response.embeddings))
    return { embedded: true }
  } catch (err) {
    log.error({ itemId: row.id, err: (err as Error).message }, 'knowledge.embedding: embed error')
    throw err  // bubble for caller; subscriber acks anyway, backstop cron retries
  }
}

export async function runEmbeddingBatch(limit = 50): Promise<{ embedded: number; errors: number }> {
  const pending = await findPendingForEmbedding(limit)
  if (pending.length === 0) return { embedded: 0, errors: 0 }
  let embedded = 0, errors = 0
  for (const row of pending) {
    try {
      const { embedded: ok } = await embedItem(row.tenantId, row.id)
      if (ok) embedded++
    } catch {
      errors++
    }
  }
  log.info({ count: pending.length, embedded, errors, processed_via: 'cron', stage: 'embed' }, 'runEmbeddingBatch: backstop cron tick')
  return { embedded, errors }
}
