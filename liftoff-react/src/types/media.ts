/**
 * The media contract, mirrored once for the whole frontend.
 *
 * The definition of record is @liftoffos/chat-attachments, published from the
 * platform backend and consumed by it, the workforce service and the tenant
 * runtime. This is the single React copy of it — a browser bundle does not pull
 * a private-registry package for eight fields — and every chat surface's wire
 * type carries `media?: MediaRef[]` while one renderer draws it, so there is
 * nothing per surface to keep in step. Change one, change the other.
 *
 * It lives in types/ rather than beside the renderer because the four chat
 * service modules need it too, and a service importing a type out of a
 * component would invert the layering for no gain.
 */
export interface MediaRef {
  /** generated_files.id — what the download route is asked for. */
  mediaId: string
  /**
   * Authoritative; drives rendering. There is deliberately no
   * `kind: 'image' | 'video'` beside it: that would duplicate what the MIME
   * already says and would eventually disagree with it.
   */
  mimeType: string
  filename: string
  sizeBytes?: number
  /** Images and video, when the producer knew them: reserves layout space so
   *  the thread does not jump when the bytes land. */
  width?: number
  height?: number
  /** Video and audio, when known. */
  durationMs?: number
  /** Producer-supplied description, used as alt text. */
  alt?: string
}
