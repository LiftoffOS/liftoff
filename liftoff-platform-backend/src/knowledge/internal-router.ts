// /api/internal/knowledge — service-auth endpoints called by tenant-runtime's
// corpus_search handler. Mounted BEFORE authMiddleware in index.ts.

import crypto from 'crypto'
import { Router, Request, Response } from 'express'
import { z } from 'zod'
import * as repo from './repository'
import { embedQuery } from './embedding-service'
import { log } from '../infrastructure/logging'

export const knowledgeInternalRouter = Router()

// Tenant-runtime sends X-Service-Auth with the value of its PLATFORM_CALLBACK_TOKEN
// env var. Other callers (workforce, governance, harvest) use their own tokens.
// Pattern matches mcp-allowlist-router.ts:21-56.
const INTERNAL_SERVICE_TOKEN_VARS = [
  'PLATFORM_CALLBACK_TOKEN',
  'CONNECTOR_SERVICE_TOKEN',
  'WORKFORCE_SERVICE_TOKEN',
  'GOVERNANCE_EVAL_SERVICE_TOKEN',
  'HARVEST_SERVICE_TOKEN',
] as const

function serviceAuth(req: Request, res: Response, next: () => void): void {
  const token = req.headers['x-service-auth'] as string | undefined
  if (!token) {
    res.status(401).json({ error: 'Missing service authentication' })
    return
  }
  const candidates = INTERNAL_SERVICE_TOKEN_VARS
    .map(v => process.env[v])
    .filter((t): t is string => Boolean(t))
  if (candidates.length === 0) {
    res.status(503).json({ error: 'Knowledge internal endpoint not configured' })
    return
  }
  const matched = candidates.some(expected => {
    try {
      return (
        Buffer.byteLength(token) === Buffer.byteLength(expected) &&
        crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected))
      )
    } catch {
      return false
    }
  })
  if (!matched) {
    res.status(401).json({ error: 'Invalid service authentication' })
    return
  }
  next()
}

const searchSchema = z.object({
  tenantId: z.string().min(1),
  connectorIds: z.array(z.string()).default([]),
  includeManual: z.boolean().default(true),
  query: z.string().min(1).max(500),
  limit: z.number().int().min(1).max(20).default(5),
  // Attribution from tenant-runtime's corpus_search handler. Required for
  // per-agent cost attribution on query-time embeddings. All optional so
  // non-agent callers (admin tooling, scripts) still work.
  agentId: z.string().optional(),
  sessionId: z.string().optional(),
  threadId: z.string().optional(),
  invocationId: z.string().optional(),
  // Knowledge IDs the agent has pinned. Positionally elevated above natural
  // matches when they hit the query. Empty/omitted = no promotion applied.
  //
  // WS-B (post-ADR-024): accept any string array at the zod boundary, then
  // filter to valid UUIDs inside the handler. The prior `z.string().uuid()`
  // form caused a hard 400 when the agent's compiled instruction emitted a
  // malformed `[[knowledge:...]]` marker token — a silent zod rejection that
  // surfaced as `corpus_search` HTTP 400 to the agent with no diagnostic.
  // Same defense-in-depth pattern WS-12.2 applied to connectorIds.
  pinnedKnowledgeIds: z.array(z.string()).default([]),
})

const countSchema = z.object({
  tenantId: z.string().min(1),
  connectorIds: z.array(z.string()).default([]),
  includeManual: z.boolean().default(true),
  /** Count everything this tenant has, ignoring connectorIds entirely.
   *
   *  For the data landscape, which describes what the WORKSPACE holds rather
   *  than what one agent's bindings reach. Scoping that number to bindings
   *  would report a smaller figure and present it as the total. */
  tenantWide: z.boolean().default(false),
})

// Hybrid retrieval is opt-in per environment: set
// `KNOWLEDGE_HYBRID_RETRIEVAL_ENABLED=true` to embed the search query via the
// OpenAI background-services key (text-embedding-3-small) and layer cosine
// similarity onto BM25 via Reciprocal Rank Fusion. Off by default so dev /
// staging run on BM25 alone, paying no per-query embedding latency or spend.
function hybridRetrievalEnabled(): boolean {
  const v = process.env.KNOWLEDGE_HYBRID_RETRIEVAL_ENABLED
  return v === 'true' || v === '1' || v === 'on'
}

knowledgeInternalRouter.post('/search', serviceAuth, async (req: Request, res: Response, next) => {
  try {
    const input = searchSchema.parse(req.body)

    // WS-12.2 — filter connectorIds to valid UUIDs only. Defensive against
    // the `connector_instance_id = "slack"` data-integrity bug (WS-5.1) and
    // similar; non-UUID inputs are dropped with a warning instead of
    // poisoning the IN-clause.
    const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    const validConnectorIds = (input.connectorIds ?? []).filter((id: string) => {
      if (UUID_RE.test(id)) return true
      log.warn({ tenant_id: input.tenantId, invalid_connector_id: id }, 'knowledge/search: dropping non-UUID connector_id')
      return false
    })

    // WS-B — same defense for pinnedKnowledgeIds. The zod schema now accepts
    // any string array (was previously strict-uuid, which caused hard 400s
    // when an agent's compiled instruction emitted a malformed
    // `[[knowledge:...]]` marker). The repo expects UUIDs downstream, so
    // drop non-UUID entries here with a warning rather than letting them
    // poison the lookup.
    const validPinnedKnowledgeIds = (input.pinnedKnowledgeIds ?? []).filter((id: string) => {
      if (UUID_RE.test(id)) return true
      log.warn({ tenant_id: input.tenantId, invalid_pinned_knowledge_id: id }, 'knowledge/search: dropping non-UUID pinned_knowledge_id')
      return false
    })

    // BM25 by default; layer RRF only when the flag is on AND embedQuery
    // returns a vector (it returns null if the OpenAI key is not configured
    // or the embed call throws — both fall through to BM25-only).
    let queryEmbedding: number[] | undefined
    if (hybridRetrievalEnabled()) {
      try {
        queryEmbedding =
          (await embedQuery(input.query, {
            tenantId: input.tenantId,
            agentId: input.agentId,
            sessionId: input.sessionId,
            threadId: input.threadId,
            invocationId: input.invocationId,
          })) ?? undefined
      } catch (err) {
        // Embedding failure must NEVER 500 the search; fall through to BM25-only.
        log.warn(
          { err: (err as Error).message, tenant_id: input.tenantId },
          'knowledge/search: embedding failed, BM25 fallback',
        )
        queryEmbedding = undefined
      }
    }

    const results = await repo.searchByTenantAndConnectors(
      input.tenantId,
      validConnectorIds,
      input.includeManual,
      input.query,
      input.limit,
      queryEmbedding,
      validPinnedKnowledgeIds,
    )
    res.json({ results })
  } catch (err) {
    // Differentiate user-input errors (zod) from server errors.
    if ((err as { name?: string })?.name === 'ZodError') {
      return res.status(400).json({ error: 'invalid input', issues: (err as { issues?: unknown }).issues })
    }
    // Pool saturation → 503 + Retry-After (same contract as WS-6.4).
    const msg = (err as Error).message
    if (msg.includes('Pool') || msg.includes('connection') || msg.includes('timeout')) {
      res.set('Retry-After', '5')
      return res.status(503).json({ error: 'temporarily unavailable' })
    }
    log.error(
      { err: msg, stack: (err as Error).stack, tenant_id: req.body?.tenantId },
      'knowledge/search failed',
    )
    next(err)
  }
})

knowledgeInternalRouter.post('/count', serviceAuth, async (req: Request, res: Response, next) => {
  try {
    const input = countSchema.parse(req.body)
    const count = input.tenantWide
      ? await repo.countAllByTenant(input.tenantId)
      : await repo.countByTenantAndConnectors(
          input.tenantId,
          input.connectorIds,
          input.includeManual,
        )
    res.json({ count })
  } catch (err) {
    next(err)
  }
})
