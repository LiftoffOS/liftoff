import crypto from 'crypto'
import { buildOidcAuthHeader } from '@liftoffos/service-client'
import { log } from '../infrastructure/logging'
import { getBackendUrl } from '../infrastructure/control-plane-url'
import * as repo from './repository'
import { publishOutboxRefs, publishOutboxRowInline } from './outbox'
import type {
  KnowledgeItem,
  CreateKnowledgeItemInput,
  BrowseResponse,
  BrowseResult,
  ContentType,
  ExtractionStatus,
} from './types'

// ── Connector-service HTTP helpers ───────────────────────────────────────────

async function buildServiceHeaders(url: string): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  const token = process.env.CONNECTOR_SERVICE_TOKEN
  if (token) headers['X-Service-Auth'] = token
  try {
    const oidcHeaders = await buildOidcAuthHeader(url)
    Object.assign(headers, oidcHeaders)
  } catch {
    // Local / CI environment — OIDC metadata server not available; X-Service-Auth covers auth
  }
  return headers
}

export async function callConnectorService<T>(
  path: string,
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE' = 'GET',
  body?: unknown,
): Promise<T> {
  const baseUrl = (process.env.CONNECTOR_SERVICE_URL ?? '').replace(/\/$/, '')
  if (!baseUrl) throw new Error('CONNECTOR_SERVICE_URL not configured')

  const url = `${baseUrl}${path}`
  const headers = await buildServiceHeaders(url)

  const res = await fetch(url, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(15_000),
  })

  if (!res.ok) {
    const text = await res.text().catch(() => '')
    throw Object.assign(new Error(`connector-service ${res.status}: ${text}`), {
      status: res.status,
    })
  }

  return res.json() as Promise<T>
}

/** A connector file is bigger than the caller is willing to hold. Its own
 *  error type because it is not a failure of the fetch: the file is there and
 *  readable, and the answer is to tell the person why it was not taken. */
export class ConnectorFileTooLargeError extends Error {
  constructor(readonly sizeBytes: number, readonly maxBytes: number) {
    super(`File is ${Math.round(sizeBytes / 1024 / 1024)} MB; the limit is ${Math.round(maxBytes / 1024 / 1024)} MB`)
    this.name = 'ConnectorFileTooLargeError'
  }
}

async function fetchBinaryFromConnectorService(
  path: string,
  options: { maxBytes?: number } = {},
): Promise<{ buffer: Buffer; contentType?: string }> {
  const baseUrl = (process.env.CONNECTOR_SERVICE_URL ?? '').replace(/\/$/, '')
  if (!baseUrl) throw new Error('CONNECTOR_SERVICE_URL not configured')

  const url = `${baseUrl}${path}`
  const headers = await buildServiceHeaders(url)

  const res = await fetch(url, {
    headers,
    signal: AbortSignal.timeout(30_000),
  })

  if (!res.ok) {
    // Carry the body. The status alone sent us the wrong way once already:
    // `binary fetch failed: 401` reads as an expired grant, while the body
    // said "No access token for connector" — a Composio-managed connector
    // that never has one. The reason a file cannot be read is the whole
    // content of this error, and it lands in the item's sync_error.
    const detail = await res.text().catch(() => '')
    throw new Error(
      `connector-service file fetch failed: ${res.status}${detail ? ` — ${detail.slice(0, 300)}` : ''}`,
    )
  }
  // The size cap, checked BEFORE the body is read. This fetch has never had
  // one: knowledge extraction called it on files a person chose from their own
  // Drive, and a 2 GB video would have been pulled into this process's heap in
  // full before anything looked at it. Content-Length is advisory — a chunked
  // response has none — so the buffer is checked again after, which bounds the
  // damage at one read rather than preventing it.
  const maxBytes = options.maxBytes
  const declaredLength = Number(res.headers.get('content-length') ?? '')
  if (maxBytes && Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    throw new ConnectorFileTooLargeError(declaredLength, maxBytes)
  }

  const buffer = Buffer.from(await res.arrayBuffer())
  if (maxBytes && buffer.length > maxBytes) {
    throw new ConnectorFileTooLargeError(buffer.length, maxBytes)
  }

  return {
    buffer,
    contentType: res.headers.get('content-type')?.split(';')[0]?.trim() || undefined,
  }
}

/**
 * Fetch a connector-hosted file's RAW bytes.
 *
 * The reusable half of extractConnectorFileText, which has always done this
 * and then immediately parsed the result into a string. Chat media needs the
 * bytes themselves, so the fetch, the SharePoint site-id derivation and the
 * external-id normalisation are lifted here rather than written a second time.
 *
 * The difference from the extraction path is one query parameter.
 * `exportAs=text` is what lets a Google Sheet arrive as CSV and what lets a
 * composio-managed connector answer at all; for media it must NOT be sent,
 * because a picture asked for as text arrives as mojibake. That is also why a
 * composio-managed connector cannot serve media: see the note at the
 * extraction call site.
 */
export async function fetchConnectorFileBytes(
  ref: ConnectorFileRef,
  options: { maxBytes: number },
): Promise<{ buffer: Buffer; contentType?: string }> {
  const rawExternalId = ref.externalId.includes(':')
    ? ref.externalId.split(':').slice(-1)[0]
    : ref.externalId

  const derivedSiteId =
    ref.connectorType === 'microsoft_sharepoint' && ref.externalId.startsWith('item:')
      ? ref.externalId.split(':')[1] || undefined
      : undefined
  const effectiveSiteId = ref.siteId ?? derivedSiteId

  const contentUrl =
    `/api/connectors/${encodeURIComponent(ref.connectorId)}/files/${encodeURIComponent(rawExternalId)}/content`
    + `?tenantId=${encodeURIComponent(ref.tenantId)}`
    + (effectiveSiteId ? `&siteId=${encodeURIComponent(effectiveSiteId)}` : '')

  return fetchBinaryFromConnectorService(contentUrl, { maxBytes: options.maxBytes })
}

// ── Connector detail lookup ──────────────────────────────────────────────────

interface ConnectorRecord {
  id: string
  type: string
  status: string
}

async function getConnector(tenantId: string, connectorId: string): Promise<ConnectorRecord | null> {
  try {
    return await callConnectorService<ConnectorRecord>(
      `/api/connectors/${connectorId}?tenantId=${encodeURIComponent(tenantId)}`,
    )
  } catch {
    return null
  }
}

// ── Public API ───────────────────────────────────────────────────────────────

export async function listItems(tenantId: string): Promise<KnowledgeItem[]> {
  return repo.listByTenant(tenantId)
}

export async function getById(tenantId: string, id: string): Promise<KnowledgeItem | null> {
  return repo.findById(id, tenantId)
}

export async function createItem(
  tenantId: string,
  input: CreateKnowledgeItemInput,
): Promise<KnowledgeItem> {
  const { item, outboxRef } = await repo.create(tenantId, input)
  if (outboxRef) await publishOutboxRowInline(outboxRef)
  return item
}

export async function batchCreateItems(
  tenantId: string,
  items: CreateKnowledgeItemInput[],
): Promise<KnowledgeItem[]> {
  const { items: created, outboxRefs } = await repo.batchCreate(tenantId, items)
  await publishOutboxRefs(outboxRefs)
  return created
}

export async function updateItem(
  tenantId: string,
  id: string,
  input: Partial<CreateKnowledgeItemInput>,
): Promise<KnowledgeItem | null> {
  return repo.update(id, tenantId, input)
}

export async function deleteItem(tenantId: string, id: string): Promise<boolean> {
  return repo.remove(id, tenantId)
}

/**
 * Delete every item imported from a connector that no longer exists.
 *
 * Called from the `connector.deleted` subscriber. Items left behind would be
 * invisible to every agent anyway — `corpus_search` scopes retrieval to the
 * connector ids the agent is bound to, and a deleted connector is bound to
 * nobody — so leaving them costs storage and makes the library lie about what
 * it holds.
 */
export async function deleteItemsForConnector(
  tenantId: string,
  connectorId: string,
): Promise<number> {
  return repo.removeByConnector(tenantId, connectorId)
}

// ── Browse ───────────────────────────────────────────────────────────────────

export async function browseConnector(
  tenantId: string,
  connectorId: string,
  options: {
    query?: string
    cursor?: string
    mimeTypes?: string
    folderId?: string
    entityType?: string
  },
): Promise<BrowseResponse> {
  const params = new URLSearchParams({ tenantId })
  if (options.query) params.set('query', options.query)
  if (options.cursor) params.set('cursor', options.cursor)
  if (options.mimeTypes) params.set('mimeTypes', options.mimeTypes)
  if (options.folderId) params.set('folderId', options.folderId)
  if (options.entityType) params.set('entityType', options.entityType)

  return callConnectorService<BrowseResponse>(
    `/api/connectors/${encodeURIComponent(connectorId)}/browse?${params.toString()}`,
  )
}

// ── Folder expansion ─────────────────────────────────────────────────────────

// Recursively expands folder items into child items. Each folder carries its own
// connectorId — the batch endpoint accepts mixed connectors in one request.
export async function expandFolderItems(
  tenantId: string,
  folderItems: KnowledgeItem[],
  depth = 0,
): Promise<void> {
  if (depth > 10) return

  for (const folder of folderItems) {
    const connectorId = folder.connectorId
    if (!connectorId) continue

    // entityType stored in metadata tells us what level to browse next (Zendesk/Intercom hierarchy)
    const entityType = folder.metadata?.expandEntityType as string | undefined
    let cursor: string | undefined
    let lastPollCursor: string | undefined

    try {
      do {
        const params = new URLSearchParams({ tenantId, folderId: folder.externalId ?? '' })
        if (cursor) params.set('cursor', cursor)
        if (entityType) params.set('entityType', entityType)

        const page = await callConnectorService<BrowseResponse>(
          `/api/connectors/${encodeURIComponent(connectorId)}/browse?${params.toString()}`,
        )

        if (page.pollCursor) lastPollCursor = page.pollCursor

        if (page.results.length > 0) {
          const isLeaf = (contentType: string) =>
            contentType !== 'folder' && contentType !== 'collection'

          // Wiki connectors (Confluence, OneNote, Notion) return pages as 'folder' so
          // expandFolderItems recurses into sub-pages, but the pages themselves contain
          // extractable content. Mark them pending so extraction runs on the page body too.
          const needsExtraction = (contentType: string): boolean =>
            isLeaf(contentType) || (contentType === 'folder' && WIKI_CONNECTOR_TYPES.has(folder.connectorType ?? ''))

          const childInputs: CreateKnowledgeItemInput[] = page.results.map((r) => ({
            title: r.title,
            sourceUrl: r.url ?? undefined,
            connectorId,
            connectorType: folder.connectorType ?? undefined,
            externalId: r.id,
            contentType: (r.contentType as ContentType) ?? 'document',
            excerpt: r.excerpt ?? undefined,
            metadata: r.metadata,
            importMode: folder.importMode,
            parentId: folder.id,
            extractionStatus: needsExtraction(r.contentType) ? 'pending' : 'none',
          }))

          const { items: children, outboxRefs } = await repo.batchCreate(tenantId, childInputs)
          await publishOutboxRefs(outboxRefs)
          const nestedFolders = children.filter((c) => c.contentType === 'folder' || c.contentType === 'collection')
          if (nestedFolders.length > 0) {
            await expandFolderItems(tenantId, nestedFolders, depth + 1)
          }
        }

        cursor = page.nextCursor ?? undefined
      } while (cursor)

      // Store the terminal Dropbox cursor for delta polling — after draining all pages,
      // the pollCursor represents "current state" so the sync job can call list_folder/continue
      if (folder.connectorType === 'dropbox' && lastPollCursor) {
        await repo.updateMetadataField(tenantId, folder.id, 'dropboxCursor', lastPollCursor)
      }

      // Register a real-time webhook for root-level storage folders (Dropbox uses polling instead)
      if (depth === 0 && folder.connectorType !== 'dropbox') {
        void registerWebhookForFolder(tenantId, folder)
      }
    } catch (err) {
      log.error(
        { tenantId, connectorId, folderId: folder.externalId, err: (err as Error).message },
        'expandFolderItems: error expanding folder',
      )
    }
  }
}

const WEBHOOK_SUPPORTED_TYPES = new Set(['google_drive', 'microsoft_onedrive', 'microsoft_sharepoint', 'box'])

// Wiki connectors (Confluence, OneNote, Notion) produce pages that are simultaneously
// browseable folders AND extractable documents. Mark them pending so extraction runs
// even when contentType is 'folder'.
const WIKI_CONNECTOR_TYPES = new Set(['atlassian_confluence', 'notion', 'microsoft_onenote'])

async function registerWebhookForFolder(tenantId: string, folder: KnowledgeItem): Promise<void> {
  if (!folder.connectorId || !folder.externalId) return
  if (!WEBHOOK_SUPPORTED_TYPES.has(folder.connectorType ?? '')) return

  // Skip if a non-expiring (or not expiring within 24h) subscription already exists.
  // Without this guard, every expandFolderItems call during a sync creates a new
  // provider-side channel and leaks the old one.
  const existing = await repo.findWebhookByExternalId(tenantId, folder.connectorId, folder.externalId)
  if (existing) {
    const expiresAt = existing.expiresAt ? new Date(existing.expiresAt) : null
    if (!expiresAt || expiresAt.getTime() - Date.now() > 24 * 60 * 60 * 1000) {
      return
    }
  }

  const backendUrl = getBackendUrl()
  const connectorType = folder.connectorType!

  let notificationUrl: string
  if (connectorType === 'google_drive') {
    notificationUrl = `${backendUrl}/api/knowledge/webhooks/google-drive`
  } else if (connectorType === 'microsoft_onedrive' || connectorType === 'microsoft_sharepoint') {
    notificationUrl = `${backendUrl}/api/knowledge/webhooks/microsoft-graph`
  } else {
    notificationUrl = `${backendUrl}/api/knowledge/webhooks/box`
  }

  const channelToken = crypto.randomUUID()

  try {
    const result = await callConnectorService<{ subscriptionId: string; expiresAt: string | null }>(
      `/api/connectors/${encodeURIComponent(folder.connectorId)}/webhooks`,
      'POST',
      { tenantId, externalId: folder.externalId, notificationUrl, channelToken },
    )

    await repo.upsertWebhookSubscription({
      tenantId,
      connectorId: folder.connectorId,
      connectorType,
      externalId: folder.externalId,
      subscriptionId: result.subscriptionId,
      channelToken,
      expiresAt: result.expiresAt,
    })

    log.info(
      { tenantId, connectorId: folder.connectorId, folderId: folder.externalId, subscriptionId: result.subscriptionId },
      'registerWebhookForFolder: webhook registered',
    )
  } catch (err) {
    log.error(
      { tenantId, connectorId: folder.connectorId, folderId: folder.externalId, err: (err as Error).message },
      'registerWebhookForFolder: failed to register webhook',
    )
  }
}

export async function cleanupWebhooksForConnector(tenantId: string, connectorId: string): Promise<void> {
  const subs = await repo.findWebhooksByConnector(tenantId, connectorId)
  for (const sub of subs) {
    try {
      await deregisterWebhook(sub, tenantId)
    } catch (err) {
      log.warn(
        { tenantId, connectorId, subscriptionId: sub.subscriptionId, err: (err as Error).message },
        'cleanupWebhooksForConnector: failed to deregister subscription',
      )
    }
  }
}

export async function deregisterWebhook(sub: { connectorId: string; connectorType: string; externalId: string; subscriptionId: string }, tenantId: string): Promise<void> {
  const body: Record<string, string> = {}
  if (sub.connectorType === 'google_drive') {
    // Google Drive requires resourceId to stop a channel — store it as channelToken if needed
    body.resourceId = ''
  }
  await callConnectorService<unknown>(
    `/api/connectors/${encodeURIComponent(sub.connectorId)}/webhooks/${encodeURIComponent(sub.subscriptionId)}`,
    'DELETE',
    Object.keys(body).length ? body : undefined,
  )
  await repo.deleteWebhookSubscription(tenantId, sub.connectorId, sub.externalId)
}

export async function renewWebhookSubscriptions(): Promise<{ renewed: number; errors: number }> {
  const expiring = await repo.findExpiringWebhooks(48)
  let renewed = 0
  let errors = 0

  for (const sub of expiring) {
    try {
      const connectorType = sub.connectorType
      let expiresAt: string | null = null

      if (connectorType === 'microsoft_onedrive' || connectorType === 'microsoft_sharepoint') {
        const result = await callConnectorService<{ subscriptionId: string; expiresAt: string | null }>(
          `/api/connectors/${encodeURIComponent(sub.connectorId)}/webhooks/${encodeURIComponent(sub.subscriptionId)}`,
          'PATCH',
          {},
        )
        expiresAt = result.expiresAt
        await repo.upsertWebhookSubscription({ ...sub, expiresAt })
      } else if (connectorType === 'google_drive') {
        // Google Drive channel tokens expire — deregister old channel first, then create new.
        // Skipping deregister leaks channels that keep firing until natural expiry.
        try {
          await callConnectorService<unknown>(
            `/api/connectors/${encodeURIComponent(sub.connectorId)}/webhooks/${encodeURIComponent(sub.subscriptionId)}`,
            'DELETE',
          )
        } catch (deregErr) {
          log.warn(
            { subscriptionId: sub.subscriptionId, err: (deregErr as Error).message },
            'renewWebhookSubscriptions: failed to deregister old GDrive channel — proceeding with new registration',
          )
        }
        const backendUrl = getBackendUrl()
        const newChannelToken = crypto.randomUUID()
        const result = await callConnectorService<{ subscriptionId: string; expiresAt: string | null }>(
          `/api/connectors/${encodeURIComponent(sub.connectorId)}/webhooks`,
          'POST',
          {
            tenantId: sub.tenantId,
            externalId: sub.externalId,
            notificationUrl: `${backendUrl}/api/knowledge/webhooks/google-drive`,
            channelToken: newChannelToken,
          },
        )
        await repo.upsertWebhookSubscription({
          ...sub,
          subscriptionId: result.subscriptionId,
          channelToken: newChannelToken,
          expiresAt: result.expiresAt,
        })
        expiresAt = result.expiresAt
      } else {
        // Box webhooks don't expire — just update the record timestamp
        expiresAt = null
      }

      log.info({ subscriptionId: sub.subscriptionId, connectorType, expiresAt }, 'renewWebhookSubscriptions: renewed')
      renewed++
    } catch (err) {
      log.error(
        { subscriptionId: sub.subscriptionId, err: (err as Error).message },
        'renewWebhookSubscriptions: renewal failed',
      )
      errors++
    }
  }

  return { renewed, errors }
}

// ── Import ───────────────────────────────────────────────────────────────────

export async function importFromConnector(
  tenantId: string,
  connectorId: string,
): Promise<{ status: string }> {
  const connector = await getConnector(tenantId, connectorId)
  const connectorType = connector?.type ?? null

  // Fire-and-forget: page through all items and upsert. We return immediately
  // so the user doesn't wait on a potentially large import.
  void (async () => {
    let cursor: string | undefined
    let totalImported = 0

    try {
      do {
        const params = new URLSearchParams({ tenantId })
        if (cursor) params.set('cursor', cursor)

        const page = await callConnectorService<BrowseResponse>(
          `/api/connectors/${encodeURIComponent(connectorId)}/browse?${params.toString()}`,
        )

        if (page.results.length > 0) {
          const isLeaf = (contentType: string) =>
            contentType !== 'folder' && contentType !== 'collection'

          const items: CreateKnowledgeItemInput[] = page.results.map((r) => ({
            title: r.title,
            sourceUrl: r.url ?? undefined,
            connectorId,
            connectorType: connectorType ?? undefined,
            externalId: r.id,
            contentType: (r.contentType as ContentType) ?? 'document',
            excerpt: r.excerpt ?? undefined,
            metadata: r.metadata,
            importMode: 'auto_import',
            extractionStatus: (isLeaf(r.contentType) ? 'pending' : 'none') as ExtractionStatus,
          }))
          const { items: created, outboxRefs } = await repo.batchCreate(tenantId, items)
          await publishOutboxRefs(outboxRefs)

          // Kick off folder expansion for any top-level folders
          const folderItems = created.filter((i) => i.contentType === 'folder')
          if (folderItems.length > 0) {
            void expandFolderItems(tenantId, folderItems)
          }

          totalImported += items.length
        }

        cursor = page.nextCursor ?? undefined
      } while (cursor)

      log.info({ tenantId, connectorId, totalImported }, 'knowledge import complete')
    } catch (err) {
      log.error({ tenantId, connectorId, err: (err as Error).message }, 'knowledge import failed')
    }
  })()

  return { status: 'importing' }
}

// ── Sync ─────────────────────────────────────────────────────────────────────

// Phrase a "no longer exists" error for the user, picking the noun off the
// row's content_type so the same code path reads naturally for files,
// folders, pages, and Notion databases.
function notFoundMessage(contentType: ContentType): string {
  switch (contentType) {
    case 'folder': return 'Folder not found'
    case 'document': return 'File not found'
    case 'page': return 'Page not found'
    case 'collection': return 'Collection not found'
    default: return 'Item not found'
  }
}

export async function syncItems(
  tenantId: string,
  connectorId?: string,
): Promise<{ synced: number; errors: number }> {
  const items = connectorId
    ? await repo.listByConnector(tenantId, connectorId)
    : await repo.listByTenant(tenantId)

  if (items.length === 0) return { synced: 0, errors: 0 }

  let errors = 0
  // Ids of items where this sync run actually failed — we exclude them from
  // the final markSynced so the row doesn't get a misleading "Synced just
  // now" label after we've already written sync_status='error' to it.
  const failedIds = new Set<string>()

  // Re-walk root folders to pick up newly added/removed files
  const rootFolders = items.filter((i) => i.contentType === 'folder' && !i.parentId)
  for (const folder of rootFolders) {
    try {
      await repo.deleteByParentId(tenantId, folder.id)
      await expandFolderItems(tenantId, [folder])
    } catch (err) {
      errors += 1
      failedIds.add(folder.id)
      const status = (err as Error & { status?: number }).status
      const message = status === 404
        ? notFoundMessage(folder.contentType)
        : `Sync failed: ${(err as Error).message}`
      await repo.markSyncError(folder.id, tenantId, message).catch((markErr) => {
        log.warn(
          { tenantId, folderId: folder.id, err: (markErr as Error).message },
          'syncItems: markSyncError failed',
        )
      })
      log.error(
        { tenantId, folderId: folder.id, status, err: (err as Error).message },
        'syncItems: folder re-walk failed',
      )
    }
  }

  // Refresh individually-picked items. These have no parent folder, so the
  // folder re-walk above doesn't touch them — their metadata is otherwise
  // captured once at import time and never refreshed.
  const fileSelectItems = items.filter(
    (i) => i.importMode === 'file_select' && !i.parentId && i.connectorId && i.externalId,
  )
  for (const item of fileSelectItems) {
    try {
      const params = new URLSearchParams({ tenantId, contentType: item.contentType })
      const refreshed = await callConnectorService<BrowseResult>(
        `/api/connectors/${encodeURIComponent(item.connectorId!)}/items/${encodeURIComponent(item.externalId!)}?${params.toString()}`,
      )
      await repo.update(item.id, tenantId, {
        title: refreshed.title || undefined,
        sourceUrl: refreshed.url ?? undefined,
        excerpt: refreshed.excerpt ?? undefined,
        metadata: refreshed.metadata,
      })
    } catch (err) {
      errors += 1
      failedIds.add(item.id)
      const status = (err as Error & { status?: number }).status
      const message = status === 404
        ? notFoundMessage(item.contentType)
        : `Sync failed: ${(err as Error).message}`
      await repo.markSyncError(item.id, tenantId, message).catch((markErr) => {
        log.warn(
          { tenantId, itemId: item.id, err: (markErr as Error).message },
          'syncItems: markSyncError failed',
        )
      })
      log.warn(
        { tenantId, itemId: item.id, connectorType: item.connectorType, status, err: (err as Error).message },
        'syncItems: file_select refresh failed',
      )
    }
  }

  // Don't mark failed rows as 'synced' — they already got sync_status='error'
  // above, and overwriting it back to 'synced' would hide the failure.
  const ids = items.map((i) => i.id).filter((id) => !failedIds.has(id))
  const synced = await repo.markSynced(ids, tenantId)
  return { synced, errors }
}

// ── Content extraction (called by extraction job) ────────────────────────────

/**
 * Ceiling on stored text per item.
 *
 * This was 100,000, applied with a bare `.slice()` and recorded nowhere. An
 * ordinary Google Sheet blows straight through it: a sheet of a thousand-odd
 * rows can export to well over twice that, so the library held only the first
 * part of the file and displayed "Synced", with nothing to indicate a cut had
 * happened. A partial import that presents as a complete one is the
 * same defect as an empty one that presents as complete.
 *
 * A ceiling still has to exist so one enormous export cannot take a batch
 * down, but it belongs well above real business documents rather than in the
 * middle of them. Text is cheap here: `extracted_text` is a Postgres TEXT
 * column, and retrieval chunks at CHUNK_CHAR_BUDGET (4,000), so cost scales
 * linearly in chunks rather than stepping at any particular size. Consumers
 * that need a smaller slice already take their own (distill uses
 * MAX_ATTACHMENT_PROMPT_CHARS).
 *
 * Tunable without a deploy for the file that inevitably exceeds even this.
 */
const MAX_EXTRACT_CHARS = Number(process.env.KNOWLEDGE_MAX_EXTRACT_CHARS ?? 1_000_000)
const ARTICLE_CONNECTOR_TYPES = new Set(['zendesk', 'intercom', 'atlassian_confluence', 'microsoft_onenote'])

function stripHtml(html: string): string {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

async function extractFromBuffer(buffer: Buffer, mimeType?: string): Promise<string> {
  if (!mimeType) return ''
  if (mimeType === 'text/plain' || mimeType === 'text/markdown') return buffer.toString('utf8')
  // Spreadsheets arrive as CSV. They used to arrive as .xlsx, which nothing
  // here can open, so every imported Google Sheet extracted to an empty
  // string and was marked done.
  if (mimeType === 'text/csv' || mimeType === 'text/tab-separated-values') {
    return buffer.toString('utf8')
  }
  if (mimeType === 'application/pdf') {
    const { default: pdfParse } = await import('pdf-parse')
    return (await pdfParse(buffer)).text
  }
  if (mimeType === 'application/vnd.openxmlformats-officedocument.wordprocessingml.document') {
    const mammoth = await import('mammoth')
    return (await mammoth.extractRawText({ buffer })).value
  }
  if (mimeType.includes('google-apps')) return buffer.toString('utf8')
  return ''
}

/** Reference to a connector-hosted file, decoupled from KnowledgeItem so
 *  non-knowledge callers (internal-agent build-time attachments) can reuse
 *  the same extraction machinery WITHOUT creating knowledge rows. */
export interface ConnectorFileRef {
  tenantId: string
  connectorId: string
  connectorType?: string | null
  externalId: string
  /** Knowledge contentType ('file' | 'document' | ...). Defaults to 'file'. */
  contentType?: string
  /** Provider MIME type when known (knowledge items carry it in metadata).
   *  When absent, inferred from fileName's extension. */
  mimeType?: string
  /** Display file name — extension used as the mimeType fallback signal. */
  fileName?: string
  /** SharePoint site id (OneDrive/SharePoint drives). */
  siteId?: string
}

/** Infer a parseable MIME type from a file name. Only the types
 *  extractFromBuffer understands; anything else returns undefined so the
 *  caller degrades to empty text instead of feeding binary to a parser. */
export function inferMimeTypeFromFileName(fileName?: string): string | undefined {
  const ext = fileName?.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase()
  switch (ext) {
    case 'txt':
    case 'log':
    case 'csv':
      return 'text/plain'
    case 'md':
    case 'markdown':
      return 'text/markdown'
    case 'pdf':
      return 'application/pdf'
    case 'docx':
      return 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    default:
      // Google-native files (Docs/Sheets) carry no extension; the connector
      // service exports them as text, matching the metadata-driven
      // 'google-apps' branch knowledge items take.
      return undefined
  }
}

export async function extractConnectorFileText(ref: ConnectorFileRef): Promise<string> {
  if (!ref.connectorId || !ref.externalId) return ''

  if (ARTICLE_CONNECTOR_TYPES.has(ref.connectorType ?? '')) {
    const result = await callConnectorService<{ html: string }>(
      `/api/connectors/${encodeURIComponent(ref.connectorId)}/content/${encodeURIComponent(ref.externalId)}`
      + `?tenantId=${encodeURIComponent(ref.tenantId)}&contentType=${encodeURIComponent(ref.contentType ?? 'file')}`,
    )
    return stripHtml(result.html ?? '').slice(0, MAX_EXTRACT_CHARS)
  }

  // Storage connectors — binary download
  const rawExternalId = ref.externalId.includes(':')
    ? ref.externalId.split(':').slice(-1)[0]
    : ref.externalId

  // A SharePoint driveItem id is unique only WITHIN its site's drive, so the
  // download needs the site as well as the item. connector-service accepts it
  // as ?siteId=, and the line below has always passed `ref.siteId` — but that
  // reads `item.metadata.siteId`, and NOTHING in this repo ever writes that
  // key. The condition was therefore never true, the param never sent, and
  // every SharePoint file resolved against /me/drive/items/<id> — the
  // connecting user's personal OneDrive, where a site's file does not exist.
  // Graph answered a well-formed 404, extraction stored '' and marked the item
  // done, so the failure looked like an empty document rather than a bug.
  //
  // The site id was never actually missing: /browse mints SharePoint ids as
  // `item:{siteId}:{driveItemId}`, so it is already inside externalId — which
  // is also why rawExternalId above takes the LAST colon segment. Deriving it
  // here fixes every already-stored item with no backfill and no metadata
  // write, and `ref.siteId` still wins if a caller has one.
  const derivedSiteId =
    ref.connectorType === 'microsoft_sharepoint' && ref.externalId.startsWith('item:')
      ? ref.externalId.split(':')[1] || undefined
      : undefined
  const effectiveSiteId = ref.siteId ?? derivedSiteId
  // exportAs=text says what this caller is: everything we do with the response
  // is parse it into a string. It buys two things. A Google Sheet arrives as
  // CSV instead of an .xlsx that extractFromBuffer has never been able to read
  // (so spreadsheets extracted to '' — silently, since an empty extraction
  // still marks the item done). And a composio_managed connector can answer at
  // all: Composio signs requests server-side and returns a decoded body, so
  // text is the only shape that survives the proxy. Without it those
  // connectors 401 on every file.
  const contentUrl =
    `/api/connectors/${encodeURIComponent(ref.connectorId)}/files/${encodeURIComponent(rawExternalId)}/content`
    + `?tenantId=${encodeURIComponent(ref.tenantId)}`
    + '&exportAs=text'
    + (effectiveSiteId ? `&siteId=${encodeURIComponent(effectiveSiteId)}` : '')

  const { buffer, contentType } = await fetchBinaryFromConnectorService(contentUrl)
  // What the response says it is beats what we assumed it would be. The
  // stored `mimeType` is the file's SOURCE type at the provider
  // (application/vnd.google-apps.spreadsheet), not the shape it arrives in
  // (text/csv), and those diverge exactly when the connector service exports
  // a Google-native file. Fall back to the guess chain only when the
  // response is unlabelled or generic.
  const responseMime =
    contentType && contentType !== 'application/octet-stream' ? contentType : undefined
  const mimeType =
    responseMime
    ?? ref.mimeType
    ?? inferMimeTypeFromFileName(ref.fileName)
    // Extensionless ids on Google Drive are native Docs the connector
    // service exports as text — same decode the 'google-apps' branch does.
    ?? (ref.connectorType === 'google_drive' ? 'application/vnd.google-apps.document' : undefined)
  const text = await extractFromBuffer(buffer, mimeType)
  return text.slice(0, MAX_EXTRACT_CHARS)
}

export async function extractItemContent(item: KnowledgeItem): Promise<string> {
  if (item.contentType === 'folder' || item.contentType === 'collection') return ''
  if (!item.connectorId || !item.externalId) return ''

  return extractConnectorFileText({
    tenantId: item.tenantId,
    connectorId: item.connectorId,
    connectorType: item.connectorType,
    externalId: item.externalId,
    contentType: item.contentType,
    mimeType: item.metadata?.mimeType as string | undefined,
    siteId: item.metadata?.siteId as string | undefined,
  })
}

// New: per-item extract + persist. Idempotent under at-least-once retry
// because markExtracting → saveExtractedText is a deterministic state machine
// on extraction_status; double-call results in the same final state.
/**
 * A knowledge item that extracted to nothing is a failed import, not a
 * finished one.
 *
 * This used to save '' with extraction_status='done' and report ok:true. The
 * row then rendered exactly like a working one — "Synced 2 minutes ago" —
 * while holding no text, so it was invisible in the library, invisible to
 * `corpus_search`, and invisible in the batch counters, which called it
 * `extracted`. Two separate bugs hid behind that for months: spreadsheets
 * exported as .xlsx that no parser here can open, and Drive files on
 * Composio-managed connectors that could not be fetched at all.
 *
 * Nothing about "we stored zero characters" should look like success. It goes
 * to extraction_status='error' with a reason the operator can read, which also
 * puts it on the retry budget (migration 357) instead of ending it.
 */
function emptyExtractionReason(item: KnowledgeItem): string {
  const sourceMime = (item.metadata?.mimeType as string | undefined) ?? item.contentType
  return (
    `No readable text found in this file (${sourceMime}). ` +
    'It may be empty, or its format may not be one we can read.'
  )
}

/** Lowercased, punctuation-stripped, single-spaced — for comparing a file's
 *  text against its own name without tripping on "(", "/" or casing. */
function normalizeForComparison(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim()
}

/**
 * True when a file's entire text is its own title.
 *
 * A knowledge item whose body repeats its name taught us nothing the row
 * already carried, and it is the shape a stub takes: a meeting-notes document
 * whose real content lives in the tool that made it, leaving a heading behind
 * in Drive. The observed case is a doc titled "Shawkat (Papr.ai) 4/20/26"
 * whose complete body is "Shawkat (Papr.ai)" — 17 characters that pass an
 * is-it-empty check while being empty in every sense that matters.
 *
 * Deliberately narrow. A short file with any content of its own is fine; this
 * only fires when the text adds nothing to the title.
 */
function isTitleOnly(text: string, title: string): boolean {
  const body = normalizeForComparison(text)
  const name = normalizeForComparison(title)
  if (!body || !name) return false
  return name.includes(body)
}

export async function extractAndPersistItem(
  item: KnowledgeItem,
): Promise<{ ok: boolean; empty?: boolean }> {
  await repo.markExtracting(item.tenantId, item.id)
  try {
    // Folders and collections are containers. They hold no content of their
    // own, so empty is the correct and final answer for them and the
    // empty-is-error rule below must not apply. Inside the try like every
    // other write, so a failure here still records an extraction error rather
    // than escaping and taking the whole batch down.
    if (item.contentType === 'folder' || item.contentType === 'collection') {
      await repo.saveExtractedText(item.tenantId, item.id, '')
      return { ok: true }
    }

    const text = await extractItemContent(item)

    const titleOnly = text.trim().length > 0 && isTitleOnly(text, item.title)

    if (text.trim().length === 0 || titleOnly) {
      const reason = titleOnly
        ? 'This file contains only its title, so there is nothing to read. ' +
          'Its content may live in the tool that created it rather than in the file.'
        : emptyExtractionReason(item)
      await repo.markExtractionError(item.tenantId, item.id, reason)
      log.warn(
        {
          itemId: item.id,
          tenantId: item.tenantId,
          connectorType: item.connectorType,
          contentType: item.contentType,
          sourceMimeType: item.metadata?.mimeType,
          extractedChars: text.trim().length,
          stage: 'extract',
          outcome: titleOnly ? 'title_only' : 'empty',
        },
        'extraction produced no usable text — recorded as an error, not a completed import',
      )
      return { ok: false, empty: true }
    }

    await repo.saveExtractedText(item.tenantId, item.id, text)

    // Hitting the ceiling means the stored text is a prefix of the file. Say
    // so on the row, so a partial import can never present as a complete one.
    // The flag is what the knowledge page reads to label it, and it is cleared
    // on any extraction that comes in under the ceiling.
    const truncated = text.length >= MAX_EXTRACT_CHARS
    if (truncated) {
      log.warn(
        {
          itemId: item.id,
          tenantId: item.tenantId,
          connectorType: item.connectorType,
          storedChars: text.length,
          limit: MAX_EXTRACT_CHARS,
          stage: 'extract',
          outcome: 'truncated',
        },
        'extraction hit the character ceiling — stored text is a prefix of the file',
      )
    }
    if (truncated || item.metadata?.extractionTruncated) {
      await repo.updateMetadataField(item.tenantId, item.id, 'extractionTruncated', truncated)
    }

    return { ok: true }
  } catch (err) {
    await repo.markExtractionError(item.tenantId, item.id, String(err))
    log.error({ itemId: item.id, err: (err as Error).message }, 'extraction error')
    return { ok: false }
  }
}

export async function runExtractionBatch(
  tenantId?: string,
): Promise<{ extracted: number; errors: number; empty: number }> {
  const items = await repo.findPendingExtraction(tenantId, 50)
  let extracted = 0
  let errors = 0
  let empty = 0

  for (const item of items) {
    const { ok, empty: wasEmpty } = await extractAndPersistItem(item)
    if (ok) extracted++
    else {
      errors++
      // Counted inside errors AND separately: "we fetched the file and got no
      // text" points at a format or an empty source, while a plain error
      // points at the connector. Alerting on the two together hides whichever
      // is smaller.
      if (wasEmpty) empty++
    }
  }

  // processed_via:'cron' lets ops alert on "cron-processed items per hour
  // > threshold" — signal that event path is broken and cron is doing the work.
  if (items.length > 0) {
    log.info({ count: items.length, extracted, errors, empty, processed_via: 'cron', stage: 'extract' }, 'runExtractionBatch: backstop cron tick')
  }

  return { extracted, errors, empty }
}
