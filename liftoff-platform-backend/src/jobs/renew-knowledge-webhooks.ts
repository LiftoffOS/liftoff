// Knowledge Webhook Renewal Job
//
// Cloud Scheduler job that runs daily. Finds knowledge_webhook_subscriptions
// expiring within 48 hours and re-registers them with the respective connector.
//
// Auth: X-Service-Auth / PLATFORM_CALLBACK_TOKEN

import crypto from 'crypto'
import { Router, type Request, type Response } from 'express'
import { log } from '../infrastructure/logging'
import { renewWebhookSubscriptions } from '../knowledge/service'

export const renewKnowledgeWebhooksRouter = Router()

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

renewKnowledgeWebhooksRouter.post(
  '/renew-knowledge-webhooks',
  async (req: Request, res: Response) => {
    if (!validateServiceAuth(req, res)) return

    try {
      const result = await renewWebhookSubscriptions()
      log.info({ ...result }, 'renew-knowledge-webhooks job complete')
      res.json({ ok: true, ...result })
    } catch (err) {
      log.error({ err: (err as Error).message }, 'renew-knowledge-webhooks job failed')
      res.status(500).json({ error: (err as Error).message })
    }
  },
)
