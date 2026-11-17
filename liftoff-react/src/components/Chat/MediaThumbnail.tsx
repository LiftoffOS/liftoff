import { useEffect, useState } from 'react'
import { getMediaUrl, peekMediaUrl } from '../../services/mediaUrl'
import { useTenant } from '../../hooks/useTenant'
import type { MediaRef } from '../../types/media'

/**
 * A small preview of a picture that has been uploaded but not yet sent.
 *
 * Its own component rather than a mode of MediaCard, because the two answer
 * different questions. MediaCard draws a piece of media that is IN the
 * transcript: it has a full-size render, an expand-to-modal, a download, and a
 * fallback card for when the bytes cannot be reached. This is a chip in the
 * composer, and the only thing it owes the person is confirmation that the file
 * they picked is the file they are about to send.
 *
 * It degrades to nothing. A thumbnail that will not load is not worth a broken
 * image box beside the filename — the filename is right there, and the pill it
 * sits in already says what is attached.
 */
export default function MediaThumbnail({ media }: { media: MediaRef }) {
  const { currentTenant } = useTenant()
  const tenantId = currentTenant?.id
  // Seeded from the cache so a re-render does not blank the thumbnail.
  const [url, setUrl] = useState<string | null>(
    () => peekMediaUrl(tenantId, media.mediaId)?.downloadUrl ?? null,
  )

  useEffect(() => {
    // The workspace context resolves a beat after first paint, so an absent
    // tenant is "not yet", never "failed". The effect re-runs when it lands.
    if (!tenantId) return
    let cancelled = false
    void (async () => {
      // Through the shared cache, so the URL this pill fetches is the same one
      // the message bubble uses a moment later. Minting a second one would make
      // the browser re-download a picture it is already showing.
      const fresh = await getMediaUrl(tenantId, media.mediaId)
      if (!cancelled && fresh) setUrl(fresh.downloadUrl)
    })()
    return () => {
      cancelled = true
    }
  }, [tenantId, media.mediaId])

  if (!url) return null
  return (
    <img
      className="chat-input__attachment-thumb"
      src={url}
      alt={media.alt || media.filename}
      loading="lazy"
    />
  )
}
