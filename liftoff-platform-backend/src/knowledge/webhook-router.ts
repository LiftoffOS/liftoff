// Knowledge Webhook Router
//
// Handles incoming webhooks from cloud storage providers for real-time folder sync.
// Must be mounted BEFORE express.json() with express.raw() to preserve raw body for HMAC.
//
// Endpoints:
//   GET  /api/knowledge/webhooks/microsoft-graph  → validationToken echo-back for subscription registration
//   POST /api/knowledge/webhooks/google-drive     → Google Drive change notification
//   POST /api/knowledge/webhooks/microsoft-graph  → OneDrive / SharePoint change notification
//   POST /api/knowledge/webhooks/box              → Box webhook notification

import { Router, type Request, type Response } from 'express'
import crypto from 'crypto'
import { log } from '../infrastructure/logging'
import * as repo from './repository'
import { expandFolderItems } from './service'
import { callConnectorService } from './service'

export const knowledgeWebhookRouter = Router()

// ── HMAC verification helpers ─────────────────────────────────────────────────

function verifyBoxWebhook(rawBody: Buffer, primaryKey: string | null, secondaryKey: string | null, signatureHeaders: { primary?: string; secondary?: string }): boolean {
  const verify = (key: string | null, sig?: string): boolean => {
    if (!key || !sig) return false
    const hmac = crypto.createHmac('sha256', key).update(rawBody).digest('hex')
    try {
      return crypto.timingSafeEqual(Buffer.from(hmac), Buffer.from(sig))
    } catch {
      return false
    }
  }
  return verify(primaryKey, signatureHeaders.primary) || verify(secondaryKey, signatureHeaders.secondary)
}

// ── Microsoft Graph: validation handshake ────────────────────────────────────
// When registering a subscription, Graph sends GET with ?validationToken=...
// Must echo it back as text/plain within 10 seconds.

knowledgeWebhookRouter.get('/webhooks/microsoft-graph', (req: Request, res: Response) => {
  const validationToken = req.query.validationToken as string | undefined
  if (validationToken) {
    res.set('Content-Type', 'text/plain')
    return res.send(validationToken)
  }
  res.status(200).end()
})

// ── Google Drive: change notification ────────────────────────────────────────

knowledgeWebhookRouter.post('/webhooks/google-drive', async (req: Request, res: Response) => {
  // Acknowledge immediately (Drive expects fast response)
  res.status(200).end()

  const channelToken = req.headers['x-goog-channel-token'] as string | undefined
  if (!channelToken) return

  try {
    const sub = await repo.findWebhookByToken(channelToken)
    if (!sub) {
      log.warn({ channelToken }, 'knowledge/webhooks/google-drive: unknown channel token')
      return
    }

    // Re-expand the folder to pick up changes
    const folder = await repo.findById(sub.externalId, sub.tenantId)
      ?? (await repo.findByExternalId(sub.tenantId, sub.connectorId, sub.externalId))
    if (!folder) return

    await repo.deleteByParentId(sub.tenantId, folder.id)
    await expandFolderItems(sub.tenantId, [folder])
  } catch (err) {
    log.error({ err: (err as Error).message }, 'knowledge/webhooks/google-drive: error processing notification')
  }
})

// ── Microsoft Graph (OneDrive / SharePoint): change notification ──────────────

knowledgeWebhookRouter.post('/webhooks/microsoft-graph', async (req: Request, res: Response) => {
  // Acknowledge immediately
  res.status(202).end()

  const body = req.body as Record<string, unknown> | undefined
  const notifications = (body?.value as Array<Record<string, unknown>>) ?? []

  for (const notification of notifications) {
    const clientState = notification.clientState as string | undefined
    if (!clientState) continue

    try {
      const sub = await repo.findWebhookByToken(clientState)
      if (!sub) {
        log.warn({ clientState }, 'knowledge/webhooks/microsoft-graph: unknown clientState')
        continue
      }

      const folder = await repo.findById(sub.externalId, sub.tenantId)
        ?? (await repo.findByExternalId(sub.tenantId, sub.connectorId, sub.externalId))
      if (!folder) continue

      await repo.deleteByParentId(sub.tenantId, folder.id)
      await expandFolderItems(sub.tenantId, [folder])
    } catch (err) {
      log.error({ err: (err as Error).message }, 'knowledge/webhooks/microsoft-graph: error processing notification')
    }
  }
})

// ── Box: change notification ──────────────────────────────────────────────────

knowledgeWebhookRouter.post('/webhooks/box', async (req: Request, res: Response) => {
  res.status(200).end()

  const rawBody = req.body as Buffer
  const primarySig = req.headers['box-signature-primary'] as string | undefined
  const secondarySig = req.headers['box-signature-secondary'] as string | undefined
  const deliveryTimestamp = req.headers['box-delivery-timestamp'] as string | undefined

  // Replay protection: reject requests older than 10 minutes
  if (deliveryTimestamp) {
    const age = Date.now() - new Date(deliveryTimestamp).getTime()
    if (age > 10 * 60 * 1000) return
  }

  try {
    const payload = JSON.parse(rawBody.toString()) as {
      trigger?: string
      source?: { id?: string; parent?: { id?: string } }
      webhook?: { id?: string }
    }

    const webhookId = payload.webhook?.id
    if (!webhookId) return

    const sub = await repo.findWebhookBySubscriptionId(webhookId)
    if (!sub) {
      log.warn({ webhookId }, 'knowledge/webhooks/box: unknown webhook id')
      return
    }

    const tenantId = sub.tenantId
    const connectorId = sub.connectorId

    // Verify HMAC using signing keys stored in connectorConfig via connector-service
    try {
      const keys = await callConnectorService<{ primaryKey: string | null; secondaryKey: string | null }>(
        `/api/connectors/${encodeURIComponent(connectorId)}/webhooks/signing-keys?tenantId=${encodeURIComponent(tenantId)}`,
      )
      const verified = verifyBoxWebhook(rawBody, keys.primaryKey, keys.secondaryKey, {
        primary: primarySig,
        secondary: secondarySig,
      })
      if (!verified) {
        log.warn({ webhookId }, 'knowledge/webhooks/box: HMAC verification failed')
        return
      }
    } catch (err) {
      log.warn({ webhookId, err: (err as Error).message }, 'knowledge/webhooks/box: could not verify HMAC, skipping')
      return
    }

    log.info({ webhookId, trigger: payload.trigger }, 'knowledge/webhooks/box: received notification')

    const folder = await repo.findByExternalId(tenantId, connectorId, sub.externalId)
    if (!folder) return

    await repo.deleteByParentId(tenantId, folder.id)
    await expandFolderItems(tenantId, [folder])
  } catch (err) {
    log.error({ err: (err as Error).message }, 'knowledge/webhooks/box: error processing notification')
  }
})
