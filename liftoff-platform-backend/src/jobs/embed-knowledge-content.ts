// Knowledge Embedding Job
//
// Cloud Scheduler job that runs every 5 minutes, picks up knowledge_items
// with extracted_text but no chunks yet, chunks the text at CHUNK_CHAR_BUDGET,
// embeds each chunk via @liftoffos/embedding (Google gemini-embedding-001
// truncated to 768d by default; OpenAI/Voyage available), and writes one row
// per chunk into knowledge_item_chunks. Usage is logged to llm_usage_log
// (via the shared client's onUsage callback in src/embedding/init.ts) with
// item_id attribution. The DB trigger from migration 238 deletes chunk rows
// when extracted_text changes, so the same `NOT EXISTS chunks` predicate
// catches fresh inserts and post-edit re-embeds.
//
// Auth: X-Service-Auth / PLATFORM_CALLBACK_TOKEN (same pattern as extract-knowledge-content.ts).

import crypto from 'crypto'
import { Router, type Request, type Response } from 'express'
import { log } from '../infrastructure/logging'
import { runEmbeddingBatch } from '../knowledge/embedding-service'

export const embedKnowledgeContentRouter = Router()

function validateServiceAuth(req: Request, res: Response): boolean {
  const serviceToken = req.headers['x-service-auth'] as string | undefined
  const expectedToken = process.env.PLATFORM_CALLBACK_TOKEN

  if (!expectedToken) {
    res.status(500).json({ error: 'Service authentication not configured' })
    return false
  }

  const isValid =
    serviceToken &&
    Buffer.byteLength(serviceToken) === Buffer.byteLength(expectedToken) &&
    crypto.timingSafeEqual(Buffer.from(serviceToken), Buffer.from(expectedToken))

  if (!isValid) {
    res.status(401).json({ error: 'Invalid service authentication' })
    return false
  }

  return true
}

embedKnowledgeContentRouter.post(
  '/embed-knowledge-content',
  async (req: Request, res: Response) => {
    if (!validateServiceAuth(req, res)) return

    try {
      const result = await runEmbeddingBatch()
      log.info(result, 'embed-knowledge-content job complete')
      res.json({ ok: true, ...result })
    } catch (err) {
      log.error({ err: (err as Error).message }, 'embed-knowledge-content job failed')
      res.status(500).json({ error: (err as Error).message })
    }
  },
)
