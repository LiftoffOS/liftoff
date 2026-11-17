import { api } from './api'

/**
 * One signed URL per piece of media, per session.
 *
 * Signed URLs cannot be stored on a message — they expire in an hour, and media
 * loads on sight, so anything older would render as a broken image forever.
 * They are therefore minted at render time. The mistake was minting them
 * SEPARATELY in each component that draws the same object.
 *
 * That cost far more than the extra request. `getSignedUrl` signs against
 * `Date.now() + 1h`, so two mints of the same object produce two DIFFERENT
 * URLs — different expiry, different signature, different query string. The
 * composer's pill downloads the picture at one URL; the moment the message
 * sends, the bubble mints another and the browser re-downloads the whole file,
 * because to an HTTP cache it is a different resource. The person watches an
 * image they were already looking at load a second time.
 *
 * Caching by (tenant, media) makes the second reader get the first reader's
 * URL, which the browser then serves out of its own cache instantly. The tenant
 * is part of the key because the same id must never be reused across a
 * workspace switch — the download route is membership-checked server-side, so a
 * stale key would fail rather than leak, but failing is not the behaviour we
 * want either.
 */

export interface MediaUrl {
  downloadUrl: string
  mimeType?: string
}

interface Entry extends MediaUrl {
  /** When this URL stops being safe to hand out. */
  goodUntil: number
}

/** The server signs for an hour. Ten minutes of headroom means a URL handed out
 *  at the edge of the window still has time to be fetched, decoded and drawn —
 *  and a cache is a performance device, so it must never be the reason an image
 *  fails. The on-error re-mint in MediaCard is the backstop beneath this. */
const LIFETIME_MS = 60 * 60 * 1000
const HEADROOM_MS = 10 * 60 * 1000

const cache = new Map<string, Entry>()
/** Requests already in flight, so four cards for one object make one request
 *  rather than four. Without this the de-duplication only starts working after
 *  the first response lands, which is exactly when it is least needed. */
const inFlight = new Map<string, Promise<MediaUrl | null>>()

const keyOf = (tenantId: string, mediaId: string): string => `${tenantId}:${mediaId}`

/**
 * The cached URL, if there is a usable one, without going to the network.
 *
 * Lets a component seed its initial state instead of rendering a placeholder
 * and swapping a frame later. For media the person just uploaded that is the
 * difference between the picture being there when the message appears and
 * appearing a beat afterwards.
 */
export function peekMediaUrl(
  tenantId: string | undefined,
  mediaId: string,
): MediaUrl | null {
  if (!tenantId) return null
  const hit = cache.get(keyOf(tenantId, mediaId))
  if (!hit || hit.goodUntil <= Date.now()) return null
  return { downloadUrl: hit.downloadUrl, ...(hit.mimeType ? { mimeType: hit.mimeType } : {}) }
}

/**
 * A usable URL for this media, from the cache when possible.
 *
 * Returns null rather than throwing for every "no URL" case — no tenant yet, a
 * media id that does not resolve, a request that failed. The callers all do the
 * same thing with those, and distinguishing them would only offer a way to
 * probe which ids exist.
 */
export async function getMediaUrl(
  tenantId: string | undefined,
  mediaId: string,
): Promise<MediaUrl | null> {
  if (!tenantId) return null
  const cached = peekMediaUrl(tenantId, mediaId)
  if (cached) return cached

  const key = keyOf(tenantId, mediaId)
  const existing = inFlight.get(key)
  if (existing) return existing

  const request = (async (): Promise<MediaUrl | null> => {
    try {
      const params = new URLSearchParams({ tenantId })
      const fresh = await api.get<{ downloadUrl: string; mimeType?: string }>(
        `/api/generated-files/${mediaId}/download?${params.toString()}`,
      )
      if (!fresh?.downloadUrl) return null
      cache.set(key, {
        downloadUrl: fresh.downloadUrl,
        ...(fresh.mimeType ? { mimeType: fresh.mimeType } : {}),
        goodUntil: Date.now() + LIFETIME_MS - HEADROOM_MS,
      })
      return { downloadUrl: fresh.downloadUrl, ...(fresh.mimeType ? { mimeType: fresh.mimeType } : {}) }
    } catch {
      return null
    } finally {
      inFlight.delete(key)
    }
  })()

  inFlight.set(key, request)
  return request
}

/**
 * Throw away what is cached and mint again.
 *
 * For the one case the cache must not paper over: the browser refused to load
 * the URL. The likeliest cause is an expiry this cache's headroom did not
 * catch, and returning the same dead URL from cache would make the retry a
 * no-op and the image broken forever.
 */
export async function refreshMediaUrl(
  tenantId: string | undefined,
  mediaId: string,
): Promise<MediaUrl | null> {
  if (!tenantId) return null
  cache.delete(keyOf(tenantId, mediaId))
  return getMediaUrl(tenantId, mediaId)
}

/** Test seam. Exported for specs that need a cold cache between cases. */
export function _resetMediaUrlCache(): void {
  cache.clear()
  inFlight.clear()
}
