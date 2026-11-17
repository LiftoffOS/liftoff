import { useCallback } from 'react'
import { useToast } from '../contexts/ToastContext'
import type { DisplayAttachment, PendingAttachment } from '../services/internalAgents'
import type { ChatMediaSurface } from '../services/chatMedia'
import type { MediaContext } from '../components/FileAttach'
import { prepareFiles } from '../components/FileAttach/FileUploadPopover.media'

/**
 * The attaching half of a chat composer, written once for the five pages that
 * have one.
 *
 * Five surfaces show the same upload button, and before media each of them
 * needed three lines: append what the popover returned, stamp a client-side id,
 * drop one on remove. Media adds a tenant, a surface, a per-message cap, a
 * paste path, a drop path, and errors that have to reach the person — six more
 * things, five times over, which is five chances for one page to quietly do
 * less than its neighbours. The Liftoff page already differed from the Insights
 * page in ways nobody intended.
 *
 * A page passes its identity and gets back everything the two components need.
 */
export function useChatAttachments(input: {
  /**
   * Which surface this composer sends on, when the page knows it.
   *
   * Four of the five do. The dashboard home page does not: it routes on an
   * @mention parsed at SEND time, so while a file is uploading the surface is
   * genuinely undecided, and the server records it at claim time instead.
   * Optional rather than defaulted, because a default here would be a guess
   * stored as a fact.
   */
  surface?: ChatMediaSurface
  tenantId: string | undefined
  /** The thread being typed in, when there is one. A brand new conversation has
   *  no id until its first message is sent, and an upload still has to work —
   *  the server claims it when the message lands. */
  threadId?: string | null
  /** The composer's current list. Defaulted because a chat hook can hand back
   *  an undefined list before its first state settles, and counting media on
   *  the message must not be the thing that throws. */
  attachments?: DisplayAttachment[]
  setAttachments: (updater: (prev: DisplayAttachment[]) => DisplayAttachment[]) => void
}) {
  const { surface, tenantId, threadId, attachments = [], setAttachments } = input
  const { showToast } = useToast()

  /**
   * Say why a file was refused, the way the rest of the app says anything.
   *
   * A toast, not a line in the composer. The pill row is where ATTACHED files
   * live, and putting a failure there mixes two meanings in one place — a
   * person scanning it has to read each entry to tell what is attached from
   * what is not. Every other refusal in this UI is a toast; a second convention
   * invented for this one case is one more thing to learn.
   *
   * One toast per file, because each names its own file and its own reason —
   * "clip.mp4 is 40 MB" and "logo.svg is not a file type you can attach here"
   * are not one message.
   */
  const report = useCallback(
    (messages: readonly string[]) => {
      for (const message of messages) showToast(message, 'error')
    },
    [showToast],
  )

  const add = useCallback(
    (pending: PendingAttachment[]) => {
      setAttachments(prev => [
        ...prev,
        ...pending.map((attachment, index) => ({
          ...attachment,
          // Client-side only, for removal from the pill row. Never sent.
          id: `${Date.now()}-${index}-${Math.random().toString(36).slice(2, 8)}`,
        })),
      ])
    },
    [setAttachments],
  )

  const remove = useCallback(
    (id: string) => setAttachments(prev => prev.filter(a => a.id !== id)),
    [setAttachments],
  )

  const mediaContext: MediaContext | undefined = tenantId
    ? { tenantId, ...(surface ? { surface } : {}), ...(threadId ? { threadId } : {}) }
    : undefined

  const existingMediaCount = attachments.filter(a => a.kind === 'media').length

  /**
   * Files that arrived by paste or by drop.
   *
   * Same preparation the picker runs, so a screenshot pasted in behaves
   * identically to one chosen from a dialog — including the size cap, the
   * per-message cap, and being told why something was refused.
   */
  const onFilesAdded = useCallback(
    (files: File[]) => {
      if (!tenantId) return
      void (async () => {
        const prepared = await prepareFiles(files, {
          tenantId,
          ...(surface ? { surface } : {}),
          ...(threadId ? { threadId } : {}),
          existingMediaCount,
        })
        if (prepared.attachments.length > 0) add(prepared.attachments)
        report(prepared.errors)
      })()
    },
    [tenantId, surface, threadId, existingMediaCount, add, report],
  )

  return {
    /** For FileUploadButton. */
    onAttach: add,
    mediaContext,
    existingMediaCount,
    onErrors: report,
    /** For ChatInput. */
    onRemoveAttachment: remove,
    onFilesAdded,
  }
}
