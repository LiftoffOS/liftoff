import type { PendingAttachment } from '../../services/internalAgents'
import {
  MAX_MEDIA_ATTACHMENTS,
  MAX_MEDIA_BYTES,
  formatBytes,
  isMediaFile,
  isTextFile,
  uploadChatMedia,
  type ChatMediaSurface,
} from '../../services/chatMedia'

/**
 * Turning what a person picked from their own computer into attachments.
 *
 * Extracted from the popover so the same decisions apply to the three ways a
 * file can arrive — the picker, a paste, a drag-and-drop — rather than living
 * in whichever one was written first. Before this there was one way in, it read
 * one file, and it read it as text: a PNG through `readAsText` is mojibake, not
 * an image.
 */

export interface PreparedAttachments {
  attachments: PendingAttachment[]
  /** One line per file that could not be attached, and why. Shown to the
   *  person rather than logged: a file that vanishes silently is the failure
   *  this whole path exists to remove. */
  errors: string[]
}

export interface PrepareContext {
  tenantId: string
  /** Absent on the composer that cannot know it yet — see UploadChatMediaInput. */
  surface?: ChatMediaSurface
  threadId?: string
  /** How many pieces of media the composer is already holding, so the cap
   *  counts the message rather than this batch. */
  existingMediaCount: number
}

/** Read one text file the way this composer always has. */
function readAsText(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (event) => resolve((event.target?.result as string) ?? '')
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`))
    reader.readAsText(file)
  })
}

/**
 * Prepare a batch of files: text inlines, media uploads, everything else is
 * refused by name.
 *
 * Files are handled INDEPENDENTLY. One that is too large, or of a type the
 * platform will not store, must not cost the person the others in the same
 * drop — which is what a single try/catch around the batch would do.
 *
 * The decisions are made in order and the UPLOADS run together. Order matters
 * for the caps: which file is the fifth picture, and therefore the one refused,
 * has to be decided deterministically rather than by whichever request happened
 * to finish first. Uploading is not — it is four independent round trips, and
 * awaiting each in turn made attaching four screenshots take four times as long
 * as attaching one for no reason at all. Results are collected back in the
 * original order, so the pills appear in the order the person picked them.
 */
export async function prepareFiles(
  files: readonly File[],
  ctx: PrepareContext,
): Promise<PreparedAttachments> {
  const errors: string[] = []
  let mediaCount = ctx.existingMediaCount
  const addedAt = new Date().toISOString()

  // One slot per input file, filled in place, so concurrency cannot reorder the
  // result. A slot stays null when the file was refused.
  const slots: Array<PendingAttachment | null> = files.map(() => null)
  const pending: Array<Promise<void>> = []

  files.forEach((file, index) => {
    if (isMediaFile(file)) {
      // Checked before the upload starts, so a 40 MB video fails in the
      // composer rather than after the person watches a progress bar.
      if (file.size > MAX_MEDIA_BYTES) {
        errors.push(
          `${file.name} is ${formatBytes(file.size)}. The limit is ${formatBytes(MAX_MEDIA_BYTES)}.`,
        )
        return
      }
      if (mediaCount >= MAX_MEDIA_ATTACHMENTS) {
        errors.push(
          `${file.name} was not attached: a message can carry ${MAX_MEDIA_ATTACHMENTS} images or clips.`,
        )
        return
      }
      // Counted NOW, while the decisions are still sequential, so the cap is
      // applied to the same files whatever order the uploads finish in.
      mediaCount += 1
      pending.push(
        uploadChatMedia({
          tenantId: ctx.tenantId,
          ...(ctx.surface ? { surface: ctx.surface } : {}),
          ...(ctx.threadId ? { threadId: ctx.threadId } : {}),
          file,
        })
          .then((media) => {
            slots[index] = { kind: 'media', name: file.name, media, addedAt }
          })
          .catch((err: Error) => {
            errors.push(err.message)
          }),
      )
      return
    }

    if (isTextFile(file)) {
      pending.push(
        readAsText(file)
          .then((content) => {
            slots[index] = { kind: 'upload', name: file.name, content, addedAt }
          })
          .catch((err: Error) => {
            errors.push(err.message)
          }),
      )
      return
    }

    // Named rather than ignored. The `accept` attribute is a filter, not a
    // guarantee — a paste and a drag-and-drop bypass it entirely — so this is
    // where a person finds out their HEIC photo or their .docx is not
    // something this composer can take.
    errors.push(`${file.name} is not a file type you can attach here.`)
  })

  await Promise.all(pending)

  return {
    attachments: slots.filter((a): a is PendingAttachment => a !== null),
    errors,
  }
}
