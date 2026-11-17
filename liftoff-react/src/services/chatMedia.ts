import { auth } from '../config/firebase'
import { API_BASE_URL, ApiError, api } from './api'
import type { MediaRef } from '../types/media'
import type { PendingAttachment } from './internalAgents'

/**
 * Attaching a picture, a clip, or a file from a connected drive.
 *
 * Two things happen here that do not happen anywhere else in this app.
 *
 * **Bytes leave the browser.** Every other request this frontend makes is JSON
 * against a 50KB body. A screenshot is not, and it never rides the chat
 * request: it is uploaded out of band and the message carries a reference.
 * `apiFetch` cannot be reused for it — it sets `Content-Type: application/json`
 * unconditionally, and a multipart body needs the boundary the browser
 * generates.
 *
 * **A pick can be REFUSED.** Files chosen from Google Drive, OneDrive, Dropbox
 * or Box are references, not files, and some of them genuinely cannot be
 * fetched. Before this module the composer accepted every pick and attached its
 * NAME — so the team was told a file called "Q3 chart.png" was attached and
 * never saw a pixel of it, and answered about a picture from its filename. The
 * refusal is the feature.
 */

// ── Caps, mirrored from @liftoffos/chat-attachments ──────────────────────
//
// The server enforces these; these copies exist so the person finds out in the
// composer instead of after a long upload. Change one, change the other.

/** How many pieces of media one message may carry. */
export const MAX_MEDIA_ATTACHMENTS = 4

/** The largest single file the ingest route will store. Set from the platform
 *  ceiling, not a preference: Cloud Run refuses a request body over 32 MB, so
 *  anything above this dies in the load balancer with nothing the person can
 *  act on. */
export const MAX_MEDIA_BYTES = 20 * 1024 * 1024

/** What the store accepts, and therefore what the file input offers. SVG is
 *  absent deliberately and permanently: it is executable markup served back
 *  from a URL this origin renders. */
export const ACCEPTED_MEDIA_TYPES = [
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'video/mp4',
  'video/webm',
  'audio/mpeg',
  'audio/mp4',
  'audio/ogg',
] as const

/** Text file extensions the composer has always read inline. Unchanged. */
export const ACCEPTED_TEXT_EXTENSIONS = '.txt,.md,.markdown,.csv,.json,.yaml,.yml'

/** The `accept` attribute for the file input: text as before, media added. */
export const FILE_INPUT_ACCEPT = `${ACCEPTED_TEXT_EXTENSIONS},${ACCEPTED_MEDIA_TYPES.join(',')}`

/** Which chat surface is asking. The four are separate tables (and, for the
 *  Chief AI Officer, a separate database), so the id alone does not say what a
 *  thread id points at. */
export type ChatMediaSurface = 'agent_chat' | 'liftoff' | 'insights' | 'team_plan'

export function isMediaFile(file: File): boolean {
  return (ACCEPTED_MEDIA_TYPES as readonly string[]).includes(file.type)
}

/** True for a file the composer should try to read as text, which is the
 *  behaviour that predates media and must be unchanged by it. */
export function isTextFile(file: File): boolean {
  if (isMediaFile(file)) return false
  const ext = file.name.match(/\.([a-z0-9]+)$/i)?.[1]?.toLowerCase()
  return !!ext && ACCEPTED_TEXT_EXTENSIONS.includes(`.${ext}`)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ── Upload ───────────────────────────────────────────────────────────────

export interface UploadChatMediaInput {
  tenantId: string
  /**
   * Which surface this will be sent on, when the composer knows it.
   *
   * The dashboard home page does not: it routes to Liftoff, the Chief AI
   * Officer, the Insights Manager or a team on an @mention it parses at SEND
   * time, long after the file was uploaded. Naming a surface there would be a
   * guess, and the server would store the guess. The claim that happens when
   * the message is actually sent is what records the truth.
   */
  surface?: ChatMediaSurface
  /** Absent on a brand new conversation, which has no thread id until the
   *  first message is sent. The server fills it in when the message claims
   *  the upload. */
  threadId?: string
  file: File
}

/**
 * Send one file's bytes to the platform and get back the reference a message
 * will carry.
 *
 * Written against `fetch` directly rather than through `apiFetch`, because that
 * helper hard-codes a JSON content type and multipart needs the boundary the
 * browser writes. The auth header is the same Firebase bearer token every other
 * request carries.
 */
export async function uploadChatMedia(input: UploadChatMediaInput): Promise<MediaRef> {
  if (input.file.size > MAX_MEDIA_BYTES) {
    throw new ApiError(
      `${input.file.name} is ${formatBytes(input.file.size)}. The limit is ${formatBytes(MAX_MEDIA_BYTES)}.`,
      400,
    )
  }

  const form = new FormData()
  form.append('file', input.file)
  form.append('tenantId', input.tenantId)
  if (input.surface) form.append('surface', input.surface)
  if (input.threadId) form.append('threadId', input.threadId)

  await auth.authStateReady()
  const token = await auth.currentUser?.getIdToken()

  const response = await fetch(`${API_BASE_URL}/api/chat-media`, {
    method: 'POST',
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: form,
  })

  if (!response.ok) {
    const body = await response.json().catch(() => ({}))
    throw new ApiError(
      body.details || body.error || `Could not upload ${input.file.name}`,
      response.status,
    )
  }

  const { media } = (await response.json()) as { media: MediaRef }
  return media
}

// ── Cloud sources ────────────────────────────────────────────────────────

export interface ConnectorPickInput {
  externalId: string
  name: string
  contentType?: string
  mimeType?: string
  sourceUrl?: string
}

export type ConnectorResolveResult =
  | { externalId: string; ok: true; attachment: PendingAttachment }
  | { externalId: string; ok: false; name: string; reason: string }

/**
 * Turn files picked from a connected drive into attachments the turn can
 * actually carry — or into a reason they cannot be.
 *
 * The server does the fetching, because the bytes live behind a connector
 * credential this browser has never held. It answers per item, and a refusal is
 * a normal answer rather than an error: some connectors can only return text,
 * some files are too large, and one of them being unreachable must not lose the
 * others.
 */
export async function resolveConnectorAttachments(input: {
  tenantId: string
  /** As above: a hint when it is known, absent when it is not. */
  surface?: ChatMediaSurface
  threadId?: string
  connectorId: string
  connectorType: string
  items: ConnectorPickInput[]
}): Promise<ConnectorResolveResult[]> {
  const { results } = await api.post<{ results: ConnectorResolveResult[] }>(
    '/api/chat-media/from-connector',
    input,
  )
  return results
}
