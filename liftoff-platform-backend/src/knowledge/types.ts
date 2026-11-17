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

export interface KnowledgeWebhookSubscription {
  id: string
  tenantId: string
  connectorId: string
  connectorType: string
  externalId: string
  subscriptionId: string
  channelToken: string
  expiresAt: string | null
  createdAt: string
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
  pollCursor?: string | null
  /** The connector cannot enumerate the requested entity — NOT the same as the
   *  account having none of it. Both look like an empty `results`, so without
   *  this the UI tells a customer their workspace is empty when the gap is on
   *  our side. Set by connector-service; passed straight through to the client,
   *  which picks the wording. */
  unsupported?: boolean
}
