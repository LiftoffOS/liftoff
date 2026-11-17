import { Router, type Request, type Response } from 'express'
import { z } from 'zod'
import { tenantAuthMiddleware } from '../infrastructure/middleware'
import { logAudit } from '../infrastructure/logging'
import { auditCtx } from '../infrastructure/audit-context'
import { withTenantScope } from '../infrastructure/database';
import * as svc from './service'

// Trim a KnowledgeItem to the audit-relevant fields. Avoids dumping the
// full row (which may carry large metadata JSONB blobs) into the audit
// log's `previous_state` / `new_state` columns.
import type { KnowledgeItem } from './types'

function pickKnowledgeAuditFields(item: KnowledgeItem): Record<string, unknown> {
  return {
    id: item.id,
    contentType: item.contentType,
    title: item.title,
    connectorId: item.connectorId,
    connectorType: item.connectorType,
    sourceUrl: item.sourceUrl,
    externalId: item.externalId,
    parentId: item.parentId,
    importMode: item.importMode,
  }
}

function pickSyncResult(result: unknown): Record<string, unknown> {
  // Sync / import results are small typed objects (count, errors). Pick a
  // bounded set; never spread arbitrary keys (could leak provider tokens
  // if a downstream service ever returned them in error payloads).
  const r = result as { count?: number; errors?: unknown[]; updated?: number } | null
  return {
    count: r?.count,
    updated: r?.updated,
    errorCount: Array.isArray(r?.errors) ? r!.errors!.length : undefined,
  }
}

export const knowledgeRouter = Router()

const contentTypes = ['article', 'document', 'page', 'folder', 'collection', 'url'] as const
const importModes = ['manual', 'auto_import', 'file_select'] as const

const createItemSchema = z.object({
  title: z.string().min(1).max(500),
  sourceUrl: z.string().url().optional(),
  connectorId: z.string().optional(),
  connectorType: z.string().optional(),
  externalId: z.string().optional(),
  contentType: z.enum(contentTypes),
  excerpt: z.string().max(2000).optional(),
  metadata: z.record(z.unknown()).optional(),
  importMode: z.enum(importModes).optional(),
})

// GET /api/knowledge?tenantId=...
knowledgeRouter.get(
  '/',
  tenantAuthMiddleware('viewDashboard'),
  async (req: Request, res: Response, next) => {
    try {
      const tenantId = req.ctx!.tenantId!
      const items = await svc.listItems(tenantId)
      res.json(items)
    } catch (err) {
      next(err)
    }
  },
)

// POST /api/knowledge?tenantId=...
knowledgeRouter.post(
  '/',
  tenantAuthMiddleware('viewDashboard'),
  async (req: Request, res: Response, next) => {
    try {
      const tenantId = req.ctx!.tenantId!
      const input = createItemSchema.parse(req.body)
      const item = await svc.createItem(tenantId, input)
      logAudit('knowledge.item_added', auditCtx(req), {
        resourceType: 'knowledge_item',
        resourceId: item.id,
        newState: pickKnowledgeAuditFields(item),
      })
      res.status(201).json(item)
    } catch (err) {
      next(err)
    }
  },
)

// POST /api/knowledge/batch?tenantId=...
knowledgeRouter.post(
  '/batch',
  tenantAuthMiddleware('viewDashboard'),
  async (req: Request, res: Response, next) => {
    try {
      const tenantId = req.ctx!.tenantId!
      const { items } = z.object({ items: z.array(createItemSchema).max(500) }).parse(req.body)

      // Set extractionStatus for non-folder/collection items from connector imports
      const itemsWithExtraction = items.map((item) => ({
        ...item,
        extractionStatus: item.connectorId && item.contentType !== 'folder' && item.contentType !== 'collection'
          ? ('pending' as const)
          : ('none' as const),
      }))

      const created = await svc.batchCreateItems(tenantId, itemsWithExtraction)

      // Fire-and-forget folder expansion for top-level folder items
      const folderItems = created.filter((i) => i.contentType === 'folder')
      if (folderItems.length > 0) {
        void svc.expandFolderItems(tenantId, folderItems)
      }

      logAudit('knowledge.batch_added', auditCtx(req), {
        resourceType: 'knowledge_batch',
        // Generate a per-batch ID so the audit row identifies one specific
        // upload (filtering by resourceId can isolate this batch from any
        // other operation). The batch isn't a stored entity, so this is a
        // synthetic UUID-shaped ID — useful as a correlation key.
        resourceId: `batch-${Date.now()}-${created[0]?.id ?? 'empty'}`,
        newState: {
          count: created.length,
          contentTypes: [...new Set(created.map((c) => c.contentType))],
          firstItemId: created[0]?.id,
          lastItemId: created[created.length - 1]?.id,
        },
      })

      res.status(201).json({ created })
    } catch (err) {
      next(err)
    }
  },
)

// GET /api/knowledge/browse?tenantId=...&connectorId=...
knowledgeRouter.get(
  '/browse',
  tenantAuthMiddleware('viewDashboard'),
  async (req: Request, res: Response, next) => {
    try {
      const tenantId = req.ctx!.tenantId!
      const { connectorId, query, cursor, mimeTypes, folderId, entityType } = req.query as Record<
        string,
        string | undefined
      >

      if (!connectorId) {
        res.status(400).json({ error: 'connectorId required' })
        return
      }

      const result = await svc.browseConnector(tenantId, connectorId, {
        query,
        cursor,
        mimeTypes,
        folderId,
        entityType,
      })
      res.json(result)
    } catch (err) {
      next(err)
    }
  },
)

// POST /api/knowledge/import?tenantId=...&connectorId=...
knowledgeRouter.post(
  '/import',
  tenantAuthMiddleware('viewDashboard'),
  async (req: Request, res: Response, next) => {
    try {
      const tenantId = req.ctx!.tenantId!
      const connectorId =
        (req.query.connectorId as string | undefined) ??
        (req.body as { connectorId?: string })?.connectorId

      if (!connectorId) {
        res.status(400).json({ error: 'connectorId required' })
        return
      }

      const result = await svc.importFromConnector(tenantId, connectorId)
      logAudit('knowledge.connector_imported', auditCtx(req), {
        resourceType: 'knowledge_import',
        resourceId: connectorId,
        newState: { connectorId, ...pickSyncResult(result) },
      })
      res.json(result)
    } catch (err) {
      next(err)
    }
  },
)

// POST /api/knowledge/sync?tenantId=...&connectorId=...
knowledgeRouter.post(
  '/sync',
  tenantAuthMiddleware('viewDashboard'),
  async (req: Request, res: Response, next) => {
    try {
      const tenantId = req.ctx!.tenantId!
      const connectorId = req.query.connectorId as string | undefined
      const result = await svc.syncItems(tenantId, connectorId)
      logAudit('knowledge.synced', auditCtx(req), {
        resourceType: 'knowledge_sync',
        resourceId: connectorId ?? tenantId,
        newState: { connectorId, ...pickSyncResult(result) },
      })
      res.json(result)
    } catch (err) {
      next(err)
    }
  },
)

// PUT /api/knowledge/:id?tenantId=...
knowledgeRouter.put(
  '/:id',
  tenantAuthMiddleware('viewDashboard'),
  async (req: Request, res: Response, next) => {
    try {
      const tenantId = req.ctx!.tenantId!
      const { id } = req.params
      const input = createItemSchema.partial().parse(req.body)
      const prior = await svc.getById(tenantId, id)
      const item = await svc.updateItem(tenantId, id, input)
      if (!item) {
        res.status(404).json({ error: 'Not found' })
        return
      }
      logAudit('knowledge.item_updated', auditCtx(req), {
        resourceType: 'knowledge_item',
        resourceId: id,
        previousState: prior ? pickKnowledgeAuditFields(prior) : undefined,
        newState: pickKnowledgeAuditFields(item),
      })
      res.json(item)
    } catch (err) {
      next(err)
    }
  },
)

// GET /api/knowledge/:id/pinning-agents?tenantId=...
// Returns the list of agents that currently pin this knowledge item.
// Used by /dashboard/knowledge to warn before deletion.
knowledgeRouter.get(
  '/:id/pinning-agents',
  tenantAuthMiddleware('viewDashboard'),
  async (req: Request, res: Response, next) => {
    try {
      const tenantId = req.ctx!.tenantId!
      const { id } = req.params
      const result = await withTenantScope(tenantId, (client) => client.query(
        `SELECT id, role
           FROM internal_agents
          WHERE tenant_id = $1
            AND pinned_knowledge_ids && ARRAY[$2::uuid]
            AND deleted_at IS NULL`,
        [tenantId, id],
      ))
      res.json({ agents: result.rows })
    } catch (err) { next(err) }
  },
)

// DELETE /api/knowledge/:id?tenantId=...
knowledgeRouter.delete(
  '/:id',
  tenantAuthMiddleware('viewDashboard'),
  async (req: Request, res: Response, next) => {
    try {
      const tenantId = req.ctx!.tenantId!
      const { id } = req.params
      const prior = await svc.getById(tenantId, id)
      const deleted = await svc.deleteItem(tenantId, id)
      if (!deleted) {
        res.status(404).json({ error: 'Not found' })
        return
      }
      logAudit('knowledge.item_removed', auditCtx(req), {
        resourceType: 'knowledge_item',
        resourceId: id,
        previousState: prior ? pickKnowledgeAuditFields(prior) : undefined,
      })
      res.status(204).end()
    } catch (err) {
      next(err)
    }
  },
)
