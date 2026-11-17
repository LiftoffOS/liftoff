// Knowledge Content Extraction Job
//
// Cloud Scheduler job that runs every 5 minutes, picks up knowledge_items with
// extraction_status = 'pending', downloads content from connector-service, and
// stores extracted_text.
//
// Auth: X-Service-Auth / PLATFORM_CALLBACK_TOKEN (same pattern as annual-plan-allocation-reset.ts).
//
// Supports:
//   Article connectors (zendesk, intercom, atlassian_confluence, microsoft_onenote):
//     Calls GET /:connectorId/content/:externalId → { html } → strip HTML → store text
//   Storage connectors (google_drive, microsoft_onedrive, dropbox, box, microsoft_sharepoint):
//     Calls GET /:connectorId/files/:fileId/content → Buffer → pdf-parse / mammoth → store text

import crypto from 'crypto'
import { Router, type Request, type Response } from 'express'
import { log } from '../infrastructure/logging'
import { runExtractionBatch } from '../knowledge/service'

export const extractKnowledgeContentRouter = Router()

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

extractKnowledgeContentRouter.post(
  '/extract-knowledge-content',
  async (req: Request, res: Response) => {
    if (!validateServiceAuth(req, res)) return

    const tenantId = (req.query.tenantId as string | undefined) ||
      (req.body as { tenantId?: string })?.tenantId

    try {
      const result = await runExtractionBatch(tenantId)
      log.info({ ...result, tenantId }, 'extract-knowledge-content job complete')
      res.json({ ok: true, ...result })
    } catch (err) {
      log.error({ err: (err as Error).message, tenantId }, 'extract-knowledge-content job failed')
      res.status(500).json({ error: (err as Error).message })
    }
  },
)
