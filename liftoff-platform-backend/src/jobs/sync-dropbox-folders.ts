// Dropbox Folder Sync Job
//
// Cloud Scheduler job that runs every 15 minutes. Dropbox webhooks are app-level
// only (not per-folder), so real-time sync is implemented via cursor-based polling.
//
// For each Dropbox folder item in knowledge_items:
//   1. Read metadata.dropboxCursor
//   2. Call list_folder/continue with the cursor
//   3. Apply delta: insert new child items, delete removed ones
//   4. Persist the new cursor in metadata.dropboxCursor
//
// Auth: X-Service-Auth / PLATFORM_CALLBACK_TOKEN

import crypto from 'crypto'
import { Router, type Request, type Response } from 'express'
import { buildOidcAuthHeader } from '@liftoffos/service-client'
import { withAdminScope } from '../infrastructure/database'
import { log } from '../infrastructure/logging'
import * as repo from '../knowledge/repository'
import { publishOutboxRefs } from '../knowledge/outbox'
import type { CreateKnowledgeItemInput, ContentType } from '../knowledge/types'

export const syncDropboxFoldersRouter = Router()

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

async function callConnectorServiceBrowse(tenantId: string, connectorId: string, cursor: string): Promise<{ results: Array<{ id: string; title: string; url: string | null; contentType: string; metadata: Record<string, unknown> }>; nextCursor: string | null }> {
  const baseUrl = (process.env.CONNECTOR_SERVICE_URL ?? '').replace(/\/$/, '')
  if (!baseUrl) throw new Error('CONNECTOR_SERVICE_URL not configured')

  const params = new URLSearchParams({ tenantId, cursor })
  const url = `${baseUrl}/api/connectors/${encodeURIComponent(connectorId)}/browse?${params.toString()}`
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = process.env.CONNECTOR_SERVICE_TOKEN
  if (token) headers['X-Service-Auth'] = token

  try {
    const oidcHeaders = await buildOidcAuthHeader(url)
    Object.assign(headers, oidcHeaders)
  } catch { /* local env */ }

  const res = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) })
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw new Error(`connector-service browse failed: ${res.status} ${text}`)
  }
  return res.json() as Promise<{ results: Array<{ id: string; title: string; url: string | null; contentType: string; metadata: Record<string, unknown> }>; nextCursor: string | null }>
}

interface DropboxFolderRow {
  id: string
  tenantId: string
  connectorId: string | null
  connectorType: string | null
  externalId: string | null
  contentType: ContentType
  metadata: Record<string, unknown>
  importMode: 'manual' | 'auto_import' | 'file_select'
  parentId: string | null
}

async function syncDropboxFolder(folder: DropboxFolderRow): Promise<void> {
  const tenantId = folder.tenantId
  const connectorId = folder.connectorId!
  const dropboxCursor = folder.metadata?.dropboxCursor as string | undefined

  if (!dropboxCursor) {
    // No cursor stored — need initial expansion; skip for now (handled by expandFolderItems at create time)
    return
  }

  try {
    // Use connector-service browse with the cursor to get delta
    // Dropbox's list_folder/continue returns only changed entries
    const delta = await callConnectorServiceBrowse(tenantId, connectorId, dropboxCursor)

    for (const entry of delta.results) {
      if (entry.contentType === 'deleted' || (entry.metadata?.deleted as boolean)) {
        // Find and delete the child item
        const existing = await repo.findByExternalId(tenantId, connectorId, entry.id)
        if (existing) {
          await repo.remove(existing.id, tenantId)
        }
      } else {
        // Upsert the new/modified item
        const isLeaf = entry.contentType !== 'folder' && entry.contentType !== 'collection'
        const input: CreateKnowledgeItemInput = {
          title: entry.title,
          sourceUrl: entry.url ?? undefined,
          connectorId,
          connectorType: folder.connectorType ?? undefined,
          externalId: entry.id,
          contentType: (entry.contentType as ContentType) ?? 'document',
          metadata: entry.metadata ?? {},
          importMode: folder.importMode,
          parentId: folder.id,
          extractionStatus: isLeaf ? 'pending' : 'none',
        }
        const { outboxRefs } = await repo.batchCreate(tenantId, [input])
        await publishOutboxRefs(outboxRefs)
      }
    }

    // Persist the new cursor
    if (delta.nextCursor) {
      await repo.updateMetadataField(tenantId, folder.id, 'dropboxCursor', delta.nextCursor)
    }
  } catch (err) {
    log.error(
      { tenantId, connectorId, folderId: folder.id, err: (err as Error).message },
      'sync-dropbox-folders: error syncing folder',
    )
  }
}

syncDropboxFoldersRouter.post(
  '/sync-dropbox-folders',
  async (req: Request, res: Response) => {
    if (!validateServiceAuth(req, res)) return

    try {
      // Find all Dropbox root folder items across all tenants. The job is a
      // platform-scheduled cross-tenant sweep, so admin scope is appropriate;
      // each per-folder sync subsequently runs under withTenantScope via the
      // repository helpers. This file is in the eslint withAdminScope
      // allowlist (eslint.config.mjs).
      const result = await withAdminScope(
        { caller: 'jobs.sync-dropbox-folders.listRootFolders', reason: 'platform-scheduled cross-tenant Dropbox cursor poll' },
        (client) => client.query(
          `SELECT * FROM knowledge_items
           WHERE connector_type = 'dropbox'
             AND content_type = 'folder'
             AND parent_id IS NULL
             AND metadata ? 'dropboxCursor'`,
        ),
      )

      const folders: DropboxFolderRow[] = result.rows.map((row: Record<string, unknown>) => ({
        id: row.id as string,
        tenantId: row.tenant_id as string,
        connectorId: row.connector_id as string | null,
        connectorType: row.connector_type as string | null,
        externalId: row.external_id as string | null,
        contentType: row.content_type as ContentType,
        metadata: (row.metadata as Record<string, unknown>) ?? {},
        importMode: row.import_mode as 'manual' | 'auto_import' | 'file_select',
        parentId: (row.parent_id as string | null) ?? null,
      }))

      await Promise.allSettled(folders.map(syncDropboxFolder))

      log.info({ folderCount: folders.length }, 'sync-dropbox-folders job complete')
      res.json({ ok: true, folderCount: folders.length })
    } catch (err) {
      log.error({ err: (err as Error).message }, 'sync-dropbox-folders job failed')
      res.status(500).json({ error: (err as Error).message })
    }
  },
)
