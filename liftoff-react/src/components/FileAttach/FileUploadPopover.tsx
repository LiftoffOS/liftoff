import { useRef, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import UploadIcon from '../../assets/icons/upload.svg?react'
import ModalOverlay from '../ModalOverlay'
import ConnectIntegrationModal from '../ConnectIntegrationModal'
import FilePicker from '../FilePicker/FilePicker'
import { getIntegrationIcon } from '../icons/integrationIconRegistry'
import { useIntegrations, type Integration } from '../../hooks/useIntegrations'
import type { ConnectorType } from '../../services/connections'
import type { BrowseResult } from '../../services/knowledge'
import type { PendingAttachment } from '../../services/internalAgents'
import {
  ACCEPTED_TEXT_EXTENSIONS,
  FILE_INPUT_ACCEPT,
  MAX_MEDIA_ATTACHMENTS,
  resolveConnectorAttachments,
  type ChatMediaSurface,
} from '../../services/chatMedia'
import { prepareFiles } from './FileUploadPopover.media'
export type { PendingAttachment } from '../../services/internalAgents'
// This component owns its stylesheet, and the ones belonging to the pieces it
// renders, so it arrives styled wherever it is used.
//
// That was not always safe. While it was re-exported from components/index.ts a
// CSS side-effect here leaked into the entry chunk, the BLOAT mode
// scripts/verify/css-closure.mjs guards, so the styles were imported by each
// route page instead. That rule was invisible and the dashboard home composer
// missed it, rendering the picker completely unstyled. It is out of the barrel
// now, reachable only from lazy route code, so the imports belong here.
import './FileUploadPopover.css'
import '../connectionModals.css'

interface FileUploadPopoverProps {
  isOpen: boolean
  onClose: () => void
  onAttach: (attachments: PendingAttachment[]) => void
  /**
   * Where this composer is, which is what turns media on.
   *
   * Absent on the agent-builder inputs, and that is the whole gate: a
   * build-time attachment is an input the distiller READS, and the distiller
   * is text-only, so a picture attached there would be stored and contribute
   * nothing. Chat surfaces pass it; the popover then accepts media, uploads
   * bytes out of band, and can resolve a cloud pick to real content.
   */
  mediaContext?: MediaContext
  /** Media the composer is already holding, so the per-message cap counts the
   *  message rather than this batch. */
  existingMediaCount?: number
  /** Reasons files could not be attached, for the composer to show. Called
   *  with an empty list when everything succeeded. */
  onErrors?: (errors: string[]) => void
}

export interface MediaContext {
  tenantId: string
  /** Absent on the dashboard home composer, which routes on an @mention parsed
   *  at send time and so cannot name a surface while the file is uploading. */
  surface?: ChatMediaSurface
  /** Absent on a brand new conversation, which has no thread id until the
   *  first message is sent. */
  threadId?: string
}

interface CloudProvider {
  type: ConnectorType
  label: string
  icon: ReactNode
}

const CLOUD_PROVIDERS: CloudProvider[] = [
  {
    type: 'google_drive',
    label: 'Google Drive',
    icon: (
      <svg viewBox="0 0 87.3 78">
        <path d="m6.6 66.85 3.85 6.65c.8 1.4 1.95 2.5 3.3 3.3l13.75-23.8h-27.5c0 1.55.4 3.1 1.2 4.5z" fill="#0066da"/>
        <path d="m43.65 25-13.75-23.8c-1.35.8-2.5 1.9-3.3 3.3l-25.4 44a9.06 9.06 0 0 0-1.2 4.5h27.5z" fill="#00ac47"/>
        <path d="m73.55 76.8c1.35-.8 2.5-1.9 3.3-3.3l1.6-2.75 7.65-13.25c.8-1.4 1.2-2.95 1.2-4.5h-27.502l5.852 11.5z" fill="#ea4335"/>
        <path d="m43.65 25 13.75-23.8c-1.35-.8-2.9-1.2-4.5-1.2h-18.5c-1.6 0-3.15.45-4.5 1.2z" fill="#00832d"/>
        <path d="m59.8 53h-32.3l-13.75 23.8c1.35.8 2.9 1.2 4.5 1.2h50.8c1.6 0 3.15-.45 4.5-1.2z" fill="#2684fc"/>
        <path d="m73.4 26.5-12.7-22c-.8-1.4-1.95-2.5-3.3-3.3l-13.75 23.8 16.15 28h27.45c0-1.55-.4-3.1-1.2-4.5z" fill="#ffba00"/>
      </svg>
    ),
  },
  {
    type: 'microsoft_onedrive',
    label: 'Microsoft OneDrive',
    icon: (
      <svg viewBox="0 0 21 21">
        <path d="M0 0h10v10H0z" fill="#f25022"/>
        <path d="M11 0h10v10H11z" fill="#7fba00"/>
        <path d="M0 11h10v10H0z" fill="#00a4ef"/>
        <path d="M11 11h10v10H11z" fill="#ffb900"/>
      </svg>
    ),
  },
  {
    type: 'dropbox',
    label: 'Dropbox',
    icon: (
      <svg viewBox="0 0 236 200" fill="#0061ff">
        <path d="M58.86 75l58.87-37.5L58.86 0 0 37.5z"/>
        <path d="M176.59 75l58.86-37.5L176.59 0l-58.86 37.5z"/>
        <path d="M117.73 112.5L58.86 75 0 112.5 58.86 150z"/>
        <path d="M176.59 150l58.86-37.5L176.59 75l-58.86 37.5z"/>
        <path d="M176.59 162.5L117.73 125l-58.87 37.5 58.87 37.5z"/>
      </svg>
    ),
  },
  {
    type: 'box',
    label: 'Box',
    icon: (
      <svg viewBox="0 0 41 22" fill="#0071F7">
        <path d="M39.7 19.2c.5.7.4 1.6-.2 2.1-.7.5-1.7.4-2.2-.2l-3.5-4.5-3.4 4.4c-.5.7-1.5.7-2.2.2-.7-.5-.8-1.4-.3-2.1l4-5.2-4-5.2c-.5-.7-.3-1.7.3-2.2.7-.5 1.7-.3 2.2.3l3.4 4.5L37.3 7c.5-.7 1.4-.8 2.2-.3.7.5.7 1.5.2 2.2L35.8 14l3.9 5.2zm-18.2-.6c-2.6 0-4.7-2-4.7-4.6 0-2.5 2.1-4.6 4.7-4.6s4.7 2.1 4.7 4.6c-.1 2.6-2.2 4.6-4.7 4.6zm-13.8 0c-2.6 0-4.7-2-4.7-4.6 0-2.5 2.1-4.6 4.7-4.6s4.7 2.1 4.7 4.6c0 2.6-2.1 4.6-4.7 4.6zM21.5 6.4c-2.9 0-5.5 1.6-6.8 4-1.3-2.4-3.9-4-6.9-4-1.8 0-3.4.6-4.7 1.5V1.5C3.1.7 2.4 0 1.6 0 .7 0 0 .7 0 1.5v12.6c.1 4.2 3.5 7.5 7.7 7.5 3 0 5.6-1.7 6.9-4.1 1.3 2.4 3.9 4.1 6.8 4.1 4.3 0 7.8-3.4 7.8-7.7.1-4.1-3.4-7.5-7.7-7.5z"/>
      </svg>
    ),
  },
]

type ModalState =
  | { type: 'connect'; integration: Integration }
  | { type: 'picker'; integration: Integration }
  | null

export default function FileUploadPopover({
  isOpen,
  onClose,
  onAttach,
  mediaContext,
  existingMediaCount = 0,
  onErrors,
}: FileUploadPopoverProps) {
  const popoverRef = useRef<HTMLDivElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const [modal, setModal] = useState<ModalState>(null)
  const [busy, setBusy] = useState(false)
  const { integrations, connected } = useIntegrations()

  useEffect(() => {
    if (!isOpen) return

    const handleClickOutside = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        onClose()
      }
    }

    document.addEventListener('mousedown', handleClickOutside)
    return () => document.removeEventListener('mousedown', handleClickOutside)
  }, [isOpen, onClose])

  const handleFileUpload = (e: React.ChangeEvent<HTMLInputElement>): void => {
    // Every file the person selected, not just the first. `files?.[0]` took one
    // per invocation regardless of what was chosen, so picking three documents
    // silently attached one.
    const files = Array.from(e.target.files ?? [])
    // Reset the input first so the same file can be picked again, and so it is
    // reset even if the work below throws.
    e.target.value = ''
    if (files.length === 0) return
    void attachFiles(files)
  }

  /** The one path every arrival takes: the picker, a paste, a drop. */
  const attachFiles = async (files: readonly File[]): Promise<void> => {
    // Without a media context this surface takes text only, exactly as it did
    // before media existed — same reader, same cap, same result.
    if (!mediaContext) {
      // No tenant means nothing can be uploaded, so `existingMediaCount` is
      // pinned at the cap: every media file is refused by name, and the text
      // files beside it are read exactly as they were before media existed.
      const { attachments, errors } = await prepareFiles(files, {
        tenantId: '',
        existingMediaCount: MAX_MEDIA_ATTACHMENTS,
      })
      if (attachments.length > 0) onAttach(attachments)
      onErrors?.(errors)
      onClose()
      return
    }
    setBusy(true)
    try {
      const { attachments, errors } = await prepareFiles(files, {
        tenantId: mediaContext.tenantId,
        ...(mediaContext.surface ? { surface: mediaContext.surface } : {}),
        ...(mediaContext.threadId ? { threadId: mediaContext.threadId } : {}),
        existingMediaCount,
      })
      if (attachments.length > 0) onAttach(attachments)
      onErrors?.(errors)
    } finally {
      setBusy(false)
      onClose()
    }
  }

  const handleProviderClick = (type: ConnectorType) => {
    const connectedInstance = connected.find(
      (i) => i.connectorType === type && i.status === 'connected',
    )
    if (connectedInstance) {
      setModal({ type: 'picker', integration: connectedInstance })
    } else {
      const catalogEntry = integrations.find((i) => i.connectorType === type)
      if (catalogEntry) setModal({ type: 'connect', integration: catalogEntry })
    }
    onClose()
  }

  const handlePickerSelect = async (results: BrowseResult[]) => {
    if (modal?.type !== 'picker' || !modal.integration.connector) return
    const connectorId = modal.integration.connector.id
    const connectorType = modal.integration.connectorType ?? ''
    const addedAt = new Date().toISOString()

    // On a surface with no media context — the agent-builder inputs — a pick
    // stays a reference, which is what the distiller resolves server-side
    // through its own extraction machinery. Nothing changes there.
    if (!mediaContext) {
      onAttach(
        results.map((r) => ({
          kind: 'connector' as const,
          name: r.title,
          connectorId,
          connectorType,
          externalId: r.id,
          sourceUrl: r.url ?? undefined,
          addedAt,
        })),
      )
      setModal(null)
      return
    }

    // In CHAT, a reference is not enough and never was. Nothing on this path
    // ever fetched the file: the model was handed the NAME, so a person who
    // attached "Q3 chart.png" got an answer invented from the filename. Ask the
    // server to resolve each pick into real content — text inlined, media
    // stored — and say plainly which ones it could not.
    setBusy(true)
    try {
      const resolved = await resolveConnectorAttachments({
        tenantId: mediaContext.tenantId,
        ...(mediaContext.surface ? { surface: mediaContext.surface } : {}),
        ...(mediaContext.threadId ? { threadId: mediaContext.threadId } : {}),
        connectorId,
        connectorType,
        items: results.map((r) => ({
          externalId: r.id,
          name: r.title,
          contentType: r.contentType,
          mimeType: (r.metadata?.mimeType as string | undefined) ?? undefined,
          sourceUrl: r.url ?? undefined,
        })),
      })
      const attached = resolved.filter((r) => r.ok).map((r) => r.attachment)
      const refusals = resolved
        .filter((r): r is Extract<typeof r, { ok: false }> => !r.ok)
        .map((r) => `${r.name}: ${r.reason}`)
      if (attached.length > 0) onAttach(attached)
      onErrors?.(refusals)
    } catch (err) {
      onErrors?.([(err as Error).message])
    } finally {
      setBusy(false)
      setModal(null)
    }
  }

  return (
    <>
      {isOpen && (
        <div ref={popoverRef} className="file-upload-popover">
          <button
            type="button"
            className="file-upload-popover__item"
            onClick={() => fileInputRef.current?.click()}
            disabled={busy}
          >
            <UploadIcon />
            {busy ? 'Uploading…' : 'Upload from computer'}
          </button>
          {CLOUD_PROVIDERS.map((provider) => (
            <button
              key={provider.type}
              type="button"
              className="file-upload-popover__item"
              onClick={() => handleProviderClick(provider.type)}
            >
              {provider.icon}
              {provider.label}
            </button>
          ))}
          <input
            ref={fileInputRef}
            type="file"
            // Media types are offered only where they can actually be stored.
            // On the agent-builder inputs the list is what it always was.
            accept={mediaContext ? FILE_INPUT_ACCEPT : ACCEPTED_TEXT_EXTENSIONS}
            multiple
            onChange={handleFileUpload}
            style={{ display: 'none' }}
          />
        </div>
      )}

      {modal?.type === 'connect' && (
        <ConnectIntegrationModal
          integration={modal.integration}
          onClose={() => setModal(null)}
        />
      )}

      {modal?.type === 'picker' && modal.integration.connector && (
        <ModalOverlay onClose={() => setModal(null)}>
          <div className="knowledge-modal">
            <div className="knowledge-modal__header">
              <span className="knowledge-modal__icon">
                {getIntegrationIcon(modal.integration.connectorType ?? '')}
              </span>
              <h2 className="knowledge-modal__title">
                Select files from {modal.integration.name}
              </h2>
            </div>
            <FilePicker
              connectorId={modal.integration.connector.id}
              onSelect={(results) => { void handlePickerSelect(results) }}
              onClose={() => setModal(null)}
              isBusy={busy}
              actionVerb="Attach"
              trackContext="team_attachment"
            />
          </div>
        </ModalOverlay>
      )}
    </>
  )
}
