// Connector type classification for the Knowledge page.
// Verify these slugs match what useConnectorCatalog() returns before shipping.

export const HELP_CENTER_CONNECTOR_TYPES = new Set([
  'zendesk',
  'intercom',
])

// google_drive covers all Google file content (Docs, Sheets, Slides, PDFs, etc.).
// Do NOT add google_docs / google_sheets / google_slides — they overlap with Drive
// and would show duplicate tiles for the same underlying files.
export const DOCUMENT_CONNECTOR_TYPES = new Set([
  'google_drive',
  'microsoft_onedrive',
  'microsoft_sharepoint',
  'microsoft_onenote',
  'dropbox',
  'box',
  'atlassian_confluence',
  'notion',
])

// MIME types the backend can extract text from.
// Passed to the browse API so users only see files we can actually read.
// Folders are always included by the backend regardless of this list.
export const EXTRACTABLE_MIME_TYPES = [
  // Google native formats
  'application/vnd.google-apps.document',
  'application/vnd.google-apps.spreadsheet',
  'application/vnd.google-apps.presentation',
  // Office Open XML
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  // Legacy Office
  'application/msword',
  'application/vnd.ms-excel',
  'application/vnd.ms-powerpoint',
  // Universal
  'application/pdf',
  'text/plain',
  'text/markdown',
  'text/csv',
] as const

export type ExtractableMimeType = typeof EXTRACTABLE_MIME_TYPES[number]

export function getKnowledgeConnectorCategory(
  connectorType: string | null | undefined,
): 'help_center' | 'document' | null {
  if (!connectorType) return null
  if (HELP_CENTER_CONNECTOR_TYPES.has(connectorType)) return 'help_center'
  if (DOCUMENT_CONNECTOR_TYPES.has(connectorType)) return 'document'
  return null
}
