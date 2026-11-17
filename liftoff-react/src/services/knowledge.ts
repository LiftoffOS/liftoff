import { api } from './api'

export type ContentType = 'article' | 'document' | 'page' | 'folder' | 'collection' | 'url'
export type SyncStatus = 'pending' | 'syncing' | 'synced' | 'error'
export type ImportMode = 'manual' | 'auto_import' | 'file_select'
export type ExtractionStatus = 'none' | 'pending' | 'extracting' | 'done' | 'error'

export interface KnowledgeItem {
  id: string
  tenantId: string
  title: string
  sourceUrl: string | null
  connectorId: string | null
  connectorType: string | null
  externalId: string | null
  contentType: ContentType
  excerpt: string | null
  metadata: Record<string, unknown>
  importMode: ImportMode
  syncStatus: SyncStatus
  lastSyncedAt: string | null
  syncError: string | null
  parentId: string | null
  extractionStatus: ExtractionStatus
  extractedText: string | null
  extractedAt: string | null
  createdAt: string
  updatedAt: string
}

export interface CreateKnowledgeItemInput {
  title: string
  sourceUrl?: string
  connectorId?: string
  connectorType?: string
  externalId?: string
  contentType: ContentType
  excerpt?: string
  metadata?: Record<string, unknown>
  importMode?: ImportMode
  parentId?: string | null
  extractionStatus?: ExtractionStatus
}

export interface BrowseResult {
  id: string
  title: string
  url: string | null
  contentType: string
  excerpt: string | null
  metadata: Record<string, unknown>
}

export interface BrowseResponse {
  results: BrowseResult[]
  nextCursor: string | null
  /** The connector cannot enumerate the requested entity, as opposed to having
   *  none of it. An empty `results` alone cannot tell those apart, and showing
   *  "nothing found" for the first case tells a customer their account is empty
   *  when the gap is on our side. Anything rendering a list must branch on it. */
  unsupported?: boolean
}

export async function listKnowledgeItems(tenantId: string): Promise<KnowledgeItem[]> {
  return api.get<KnowledgeItem[]>(`/api/knowledge?tenantId=${tenantId}`)
}

export async function createKnowledgeItem(
  tenantId: string,
  input: CreateKnowledgeItemInput,
): Promise<KnowledgeItem> {
  return api.post<KnowledgeItem>(`/api/knowledge?tenantId=${tenantId}`, input)
}

export async function batchCreateKnowledgeItems(
  tenantId: string,
  items: CreateKnowledgeItemInput[],
): Promise<{ created: KnowledgeItem[] }> {
  return api.post<{ created: KnowledgeItem[] }>(`/api/knowledge/batch?tenantId=${tenantId}`, { items })
}

export async function updateKnowledgeItem(
  tenantId: string,
  id: string,
  input: Partial<CreateKnowledgeItemInput>,
): Promise<KnowledgeItem> {
  return api.put<KnowledgeItem>(`/api/knowledge/${id}?tenantId=${tenantId}`, input)
}

export async function deleteKnowledgeItem(tenantId: string, id: string): Promise<void> {
  return api.delete<void>(`/api/knowledge/${id}?tenantId=${tenantId}`)
}

/** A team that has this item pinned. `role` is the team's display name. */
export interface PinningTeam {
  id: string
  role: string
}

/**
 * Teams that currently pin a knowledge item. Called before removing one, so a
 * deletion that quietly takes context away from a working team asks first.
 */
export async function getPinningTeams(tenantId: string, id: string): Promise<PinningTeam[]> {
  const response = await api.get<{ agents: PinningTeam[] }>(
    `/api/knowledge/${id}/pinning-agents?tenantId=${tenantId}`,
  )
  return response.agents ?? []
}

export async function browseConnector(
  tenantId: string,
  connectorId: string,
  query?: string,
  cursor?: string,
  mimeTypes?: readonly string[],
  folderId?: string,
  entityType?: string,
): Promise<BrowseResponse> {
  const params = new URLSearchParams({ tenantId, connectorId })
  if (query) params.append('query', query)
  if (cursor) params.append('cursor', cursor)
  if (mimeTypes && mimeTypes.length > 0) params.append('mimeTypes', mimeTypes.join(','))
  if (folderId) params.append('folderId', folderId)
  if (entityType) params.append('entityType', entityType)
  return api.get<BrowseResponse>(`/api/knowledge/browse?${params.toString()}`)
}

export async function importConnector(
  tenantId: string,
  connectorId: string,
): Promise<{ status: string }> {
  return api.post<{ status: string }>(
    `/api/knowledge/import?tenantId=${tenantId}&connectorId=${connectorId}`,
  )
}

export async function syncItems(
  tenantId: string,
  connectorId?: string,
): Promise<{ synced: number; errors: number }> {
  const params = new URLSearchParams({ tenantId })
  if (connectorId) params.append('connectorId', connectorId)
  return api.post<{ synced: number; errors: number }>(`/api/knowledge/sync?${params.toString()}`)
}
