import { useCallback, useEffect, useRef, useState } from 'react'
import { getMediaUrl, peekMediaUrl, refreshMediaUrl } from '../../services/mediaUrl'
import { useTenant } from '../../hooks/useTenant'
import ModalOverlay from '../ModalOverlay'
import type { MediaRef } from '../../types/media'
import FileTextIcon from '../../assets/icons/file-text.svg?react'
import XIcon from '../../assets/icons/x.svg?react'
import DownloadIcon from '../../assets/icons/download.svg?react'

/**
 * One image, drawn the same way wherever it came from.
 *
 * Exported because the markdown renderer routes its `img` through this too: an
 * image an agent linked in its reply and an image it produced as an artifact
 * should not be two different-looking things in the same bubble.
 *
 * Sizing is the whole job. Without an intrinsic ratio the thread reflows the
 * moment the bytes arrive, and without a height cap one tall screenshot pushes
 * the conversation off the screen.
 */
export function ChatImage({
  src,
  alt,
  onError,
  onClick,
}: {
  src: string
  alt: string
  onError?: () => void
  onClick?: () => void
}) {
  const img = (
    <img
      className="chat-media__image"
      src={src}
      alt={alt}
      loading="lazy"
      // NO imposed aspect ratio. The image knows its own shape once it decodes,
      // and an imposed one can only ever be wrong — it was.
      //
      // The stored dimensions come from the JPEG frame header, which is raw
      // pixels BEFORE EXIF rotation. A phone photo shot in portrait is stored
      // as landscape pixels with an orientation flag; the browser rotates it on
      // render. Writing those numbers into `aspect-ratio` told the layout the
      // picture was landscape when it draws portrait, and the image was
      // stretched sideways to fill the box.
      //
      // Reserving space is the PLACEHOLDER's job, and it is a different element
      // that is gone by the time this one paints. So this element sizes itself
      // from the bytes, which is the only source that cannot disagree with what
      // the reader sees.
      onError={onError}
    />
  )
  if (!onClick) return img
  return (
    <button type="button" className="chat-media__expand" onClick={onClick} aria-label={`Expand ${alt}`}>
      {img}
    </button>
  )
}

/**
 * An image the agent wrote into its reply as markdown, drawn exactly like one
 * it produced as an artifact — same sizing, same expand, same degradation.
 *
 * Its own component because the artifact card cannot serve it: there is no
 * MediaRef and no signed URL to mint, only whatever URL the agent linked. What
 * it must NOT do is differ visibly from the artifact branch, which is the whole
 * reason the markdown renderer routes through here at all.
 */
export function MarkdownImage({
  src,
  alt,
}: {
  src: string
  alt: string
}) {
  const [broken, setBroken] = useState(false)
  const [expanded, setExpanded] = useState(false)

  // A URL that will not load is still a fact the reply asserted. Falling back to
  // the link keeps it reachable and keeps the alt text readable, instead of
  // leaving the browser's broken-image glyph in the middle of a sentence.
  if (broken) {
    return (
      <a className="chat-media__broken" href={src} target="_blank" rel="noopener noreferrer">
        {alt || src}
      </a>
    )
  }

  return (
    <>
      <ChatImage
        src={src}
        alt={alt}
        onError={() => setBroken(true)}
        onClick={() => setExpanded(true)}
      />
      {expanded && <ExpandedImage src={src} alt={alt} onClose={() => setExpanded(false)} />}
    </>
  )
}

/** The full-size view. A button rather than a bare <img> so it can be closed by
 *  clicking it as well as by Escape or the backdrop, and so a keyboard reaches
 *  it — the overlay stops propagation on its own content, so an onClick on the
 *  image alone would be the only way out that does not work. */
function ExpandedImage({
  src,
  alt,
  onClose,
}: {
  src: string
  alt: string
  onClose: () => void
}) {
  return (
    // --media, not --wide. `--wide` is the pricing grid's fixed 960px box; a
    // photograph needs a box that takes ITS shape rather than one that imposes
    // a landscape one on it.
    <ModalOverlay onClose={onClose} contentClassName="modal-overlay__content--media">
      <div className="chat-media__expanded-frame">
        {/* The same .modal-close every other modal in the app carries, so the
            way out of this one is the way out of all of them. It is an ADDITION
            rather than a replacement: clicking the picture still closes it, and
            so does Escape and the backdrop. Discoverability is the gap it
            fills — nothing on screen previously said the image was dismissable,
            and a reader who does not guess that clicking it works is stuck
            looking for a control that is not there. */}
        <button
          type="button"
          className="modal-close chat-media__expanded-close"
          onClick={onClose}
          aria-label="Close"
        >
          <XIcon width={16} height={16} />
        </button>
        <button
          type="button"
          className="chat-media__collapse"
          onClick={onClose}
          aria-label={`Close ${alt}`}
        >
          <img className="chat-media__image chat-media__image--expanded" src={src} alt={alt} />
        </button>
      </div>
    </ModalOverlay>
  )
}

/**
 * The card shown when there is nothing to draw: a MIME nothing renders, or
 * media whose bytes would not load.
 *
 * Deliberately NOT FileOutputCard. That component carries a connector
 * re-authorization branch — "Couldn't save to your cloud storage. Re-authorize"
 * — which is about a document the agent tried to write into Drive or SharePoint
 * and has nothing to say about a picture. Reusing it would put that sentence
 * under every screenshot whose signed URL had expired.
 */
function MediaFallbackCard({
  media,
  downloadUrl,
  onRetry,
}: {
  media: MediaRef
  downloadUrl: string | null
  onRetry: () => Promise<string | null>
}) {
  const handleDownload = async () => {
    // The URL in hand may be the expired one that brought us here, so ask for a
    // fresh one first and only fall back to it.
    const fresh = await onRetry()
    const url = fresh ?? downloadUrl
    if (url) window.open(url, '_blank', 'noopener,noreferrer')
  }
  return (
    <div className="file-output-card">
      <div className="file-output-card__icon">
        <FileTextIcon />
      </div>
      <span className="file-output-card__name">{media.filename}</span>
      <div className="file-output-card__actions">
        <button
          className="file-output-card__action-btn"
          onClick={handleDownload}
          aria-label={`Download ${media.filename}`}
        >
          <DownloadIcon />
        </button>
      </div>
    </div>
  )
}

interface MediaCardProps {
  media: MediaRef
}

/**
 * Media in a chat bubble, drawn by MIME type.
 *
 * The signed URL is minted HERE, on mount, rather than read out of the stored
 * message. The URL baked into a message at write time lasts an hour; a file
 * card can work around that on click, but media loads on sight, so anything
 * older than an hour would render as a broken image forever. The download route
 * already enforces Firebase auth, tenant membership and RLS, so re-minting
 * costs one request and no new surface.
 */
export function MediaCard({ media }: MediaCardProps) {
  const { currentTenant } = useTenant()
  const tenantId = currentTenant?.id
  // Seeded from the shared cache. For media the person has just sent, the
  // composer's pill already minted a URL for this exact object, so the picture
  // is on screen the moment the message is — rather than after a round trip and
  // a second download of a file the browser is already holding.
  const seed = peekMediaUrl(tenantId, media.mediaId)
  const [url, setUrl] = useState<string | null>(seed?.downloadUrl ?? null)
  const [servedMimeType, setServedMimeType] = useState<string | null>(seed?.mimeType ?? null)
  const [failed, setFailed] = useState(false)
  const [expanded, setExpanded] = useState(false)

  const fetchUrl = useCallback(async (): Promise<
    { downloadUrl: string; mimeType?: string } | null
  > => {
    // No tenant yet is NOT a failure — the workspace context resolves a beat
    // after first paint. Answering `null` here and letting the caller record a
    // failure is what made every image on a cold load degrade to a file card
    // and stay there, because the successful retry could not clear the flag.
    return getMediaUrl(tenantId, media.mediaId)
  }, [tenantId, media.mediaId])

  useEffect(() => {
    // Nothing to ask for until the workspace is known. The effect re-runs when
    // it is, because fetchUrl's identity depends on it.
    if (!tenantId) return
    // Already have one from the cache; asking again would only mint a second
    // URL for the same object and cost the browser its cached copy.
    if (url) return
    let cancelled = false
    void (async () => {
      const fresh = await fetchUrl()
      if (cancelled) return
      if (fresh?.downloadUrl) {
        setUrl(fresh.downloadUrl)
        setServedMimeType(fresh.mimeType ?? null)
        // A later success clears an earlier failure. Without this the card is a
        // one-way door: retry succeeds, state says otherwise, render disagrees
        // with both.
        setFailed(false)
      } else {
        setFailed(true)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [fetchUrl, tenantId, url])

  // Producer-supplied description first, the filename second. Never empty: an
  // image with no alt text is invisible to anyone not looking at the screen.
  const alt = media.alt || media.filename

  const retry = useCallback(async () => {
    // Forces a re-mint. The cache must not paper over the one case that
    // matters — the browser refused the URL — or the retry is a no-op and the
    // image stays broken.
    const fresh = await refreshMediaUrl(tenantId, media.mediaId)
    if (fresh?.downloadUrl) {
      setUrl(fresh.downloadUrl)
      setServedMimeType(fresh.mimeType ?? null)
      setFailed(false)
      return fresh.downloadUrl
    }
    return null
  }, [tenantId, media.mediaId])

  /**
   * What to do when the browser cannot load the bytes.
   *
   * By far the likeliest cause is the one this component exists to handle: the
   * signed URL aged out while the thread sat open. So re-mint ONCE and try
   * again silently — that is what the person wants and they never need to know
   * it happened. Only a second failure is a real one, and then the card takes
   * over. The ref is what bounds it: a fresh URL that also fails would
   * otherwise re-mint forever, one request per failed paint.
   */
  const remintedRef = useRef(false)
  const handleLoadError = useCallback(() => {
    if (remintedRef.current) {
      setFailed(true)
      return
    }
    remintedRef.current = true
    void (async () => {
      const fresh = await retry()
      if (!fresh) setFailed(true)
    })()
  }, [retry])

  if (failed) {
    return <MediaFallbackCard media={media} downloadUrl={url} onRetry={retry} />
  }

  if (!url) {
    // Holds the shape the media will take, so the bubble does not resize twice.
    return (
      <div
        className="chat-media chat-media--loading"
        // Both custom properties come from the SAME stored dimensions and are
        // read by one rule in the stylesheet: the ratio shapes the box, and the
        // unitless copy of it lets CSS clamp the width to `max-height x ratio`.
        // That second half is what stops a portrait image reserving a
        // bubble-wide, screen-tall grey rectangle it will never occupy.
        style={
          media.width && media.height
            ? ({
                '--chat-media-ar': `${media.width} / ${media.height}`,
                '--chat-media-ar-num': `${media.width / media.height}`,
              } as React.CSSProperties)
            : undefined
        }
        aria-busy="true"
        aria-label={`Loading ${alt}`}
      />
    )
  }

  // The stored ref is authoritative — it is the contract every surface persists
  // — and the download route's value is the same column read back, so it stands
  // in for a ref written before the field existed or by a producer that omitted
  // it. Dispatching on nothing would render media as a file card forever.
  const type = (media.mimeType || servedMimeType || '').toLowerCase()

  if (type.startsWith('image/')) {
    return (
      <div className="chat-media">
        <ChatImage
          src={url}
          alt={alt}
          onError={handleLoadError}
          onClick={() => setExpanded(true)}
        />
        {expanded && <ExpandedImage src={url} alt={alt} onClose={() => setExpanded(false)} />}
      </div>
    )
  }

  if (type.startsWith('video/')) {
    return (
      <div className="chat-media">
        {/* Never autoplays: a reply that starts making noise on its own is not
            something anybody asked for. `preload="metadata"` fetches the header
            so the duration and first frame are known without pulling the file. */}
        <video
          className="chat-media__video"
          src={url}
          controls
          preload="metadata"
          aria-label={alt}
          onError={handleLoadError}
        >
          {/* No caption track exists for agent-produced video: nothing in the
              pipeline transcribes it. Declared empty rather than omitted so the
              element still advertises the slot. */}
          <track kind="captions" />
        </video>
      </div>
    )
  }

  if (type.startsWith('audio/')) {
    return (
      <div className="chat-media">
        <audio
          className="chat-media__audio"
          src={url}
          controls
          preload="metadata"
          aria-label={alt}
          onError={handleLoadError}
        >
          <track kind="captions" />
        </audio>
      </div>
    )
  }

  return <MediaFallbackCard media={media} downloadUrl={url} onRetry={retry} />
}
