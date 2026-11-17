import { useState, useRef, useEffect } from 'react'
import { ModalOverlay, ConnectIntegrationModal, PageHeader, Tooltip, Button } from '../../components'
import FilePicker from '../../components/FilePicker/FilePicker'
import { useIntegrations, type Integration } from '../../hooks/useIntegrations'
import { useTenant } from '../../hooks/useTenant'
import { connectedAccountLabel } from '../../utils/connectedAccountLabel'
import { useToast } from '../../contexts/ToastContext'
import {
  useKnowledgeItems,
  useBatchCreateKnowledgeItems,
  useDeleteKnowledgeItem,
  useSyncItems,
  type KnowledgeItem,
} from '../../hooks/useKnowledge'
import { getPinningTeams, type PinningTeam } from '../../services/knowledge'
import type { CreateKnowledgeItemInput, BrowseResult } from '../../services/knowledge'
import { getIntegrationIcon } from '../../components/icons/integrationIconRegistry'
import {
  HELP_CENTER_CONNECTOR_TYPES,
  DOCUMENT_CONNECTOR_TYPES,
} from '../../config/knowledgeConnectors'
import FileTextIcon from '../../assets/icons/file-text.svg?react'
import LinkIcon from '../../assets/icons/link.svg?react'
import ChevronDownIcon from '../../assets/icons/chevron-down.svg?react'
import RefreshCwIcon from '../../assets/icons/refresh-cw.svg?react'
import './ConnectionsPage.css'
// Renders .connection-card; those rules live in connectionCard.css, not in
// ConnectionsPage.css.
import './connectionCard.css'
import './KnowledgePage.css'
// This page renders <ConnectIntegrationModal> and ManageCustomMcpServerModal,
// which use the shared .connection-modal__* styles. Load them here — they no
// longer come with ConnectionsPage.css.
import '../../components/connectionModals.css'
import { track } from '../../lib/analytics'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function formatRelativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime()
  const mins = Math.floor(diff / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} ${mins === 1 ? 'minute' : 'minutes'} ago`
  const hrs = Math.floor(mins / 60)
  if (hrs < 24) return `${hrs} ${hrs === 1 ? 'hour' : 'hours'} ago`
  const days = Math.floor(hrs / 24)
  if (days < 7) return `${days} ${days === 1 ? 'day' : 'days'} ago`
  const date = new Date(iso)
  return `on ${date.toLocaleString('en-US', { month: 'long', day: 'numeric' })}`
}

function pluralItems(n: number): string {
  return `${n} item${n !== 1 ? 's' : ''}`
}

/** A confirmed picker change held back while the pin warning is answered. */
interface PendingRemoval {
  newItems: CreateKnowledgeItemInput[]
  toDelete: KnowledgeItem[]
  pinned: Array<{ item: KnowledgeItem; teams: PinningTeam[] }>
}

/** "Sales Development Rep", "Sales Development Rep and Recruiter", "A, B and C". */
function listTeamNames(teams: PinningTeam[]): string {
  const names = teams.map((t) => t.role)
  if (names.length <= 1) return names[0] ?? ''
  return `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`
}

/** "Added 2 items", "Removed 1 item", "Added 2 items and removed 1 item". */
function describeChanges(added: number, removed: number): string {
  if (added > 0 && removed > 0) {
    return `Added ${pluralItems(added)} and removed ${pluralItems(removed)}`
  }
  if (removed > 0) return `Removed ${pluralItems(removed)}`
  return `Added ${pluralItems(added)}`
}

// ─── Knowledge Item Card ───────────────────────────────────────────────────────

interface KnowledgeItemCardProps {
  item: KnowledgeItem
  onSync: (connectorId: string | undefined, name: string) => void
  isSyncing: boolean
}

function KnowledgeItemCard({ item, onSync, isSyncing }: KnowledgeItemCardProps) {
  const displayTitle = item.title || 'Untitled'
  const icon = item.importMode === 'manual' ? <LinkIcon /> : <FileTextIcon />
  const hasLink = Boolean(item.sourceUrl)

  // Backend writes a short, user-facing reason into sync_error for the
  // 404-from-vendor case — "File not found", "Folder not found", "Page not
  // found", "Collection not found", "Item not found". When we see that
  // shape, inline the reason in the label. Other errors stay as the
  // generic "Sync failed" with the raw message in a tooltip.
  const isNotFoundError =
    item.syncStatus === 'error' && /\bnot found$/i.test(item.syncError ?? '')

  // Sync and extraction are different questions. Sync is "did the row arrive";
  // extraction is "can anything read the file". A file that arrives and cannot
  // be read used to show "Synced 2 minutes ago" and look finished, so an item
  // holding no text was indistinguishable from a working one — in the list, and
  // to the teams searching it. Extraction state wins the label when it has
  // something to say.
  const extractionInfo = item.extractionStatus === 'error' ? (
    <Tooltip text={item.syncError || 'This file could not be read'} position="top">
      <span className="knowledge-item__sync-info knowledge-item__sync-info--error">
        No text could be read
      </span>
    </Tooltip>
  ) : item.extractionStatus === 'pending' || item.extractionStatus === 'extracting' ? (
    <span className="knowledge-item__sync-info knowledge-item__sync-info--syncing">Reading…</span>
  ) : item.metadata?.extractionTruncated === true ? (
    // The stored text is a prefix of the file. Saying "Synced" here would
    // describe a partial import as a finished one, which is the same lie as
    // calling an empty one finished.
    <Tooltip
      text="This file is longer than we store per item. Teams will see the beginning of it, not all of it."
      position="top"
    >
      <span className="knowledge-item__sync-info knowledge-item__sync-info--error">
        Partially read
      </span>
    </Tooltip>
  ) : null

  const syncInfo = extractionInfo ? extractionInfo : item.syncStatus === 'synced' && item.lastSyncedAt ? (
    <span className="knowledge-item__sync-info">
      Synced {formatRelativeTime(item.lastSyncedAt)}
    </span>
  ) : item.syncStatus === 'syncing' ? (
    <span className="knowledge-item__sync-info knowledge-item__sync-info--syncing">Syncing…</span>
  ) : item.syncStatus === 'error' ? (
    isNotFoundError ? (
      <span className="knowledge-item__sync-info knowledge-item__sync-info--error">
        Sync failed ({(item.syncError as string).toLowerCase()})
      </span>
    ) : (
      <Tooltip text={item.syncError || 'Sync failed'} position="top">
        <span className="knowledge-item__sync-info knowledge-item__sync-info--error">Sync failed</span>
      </Tooltip>
    )
  ) : null

  const handleRowClick = () => {
    track('knowledge_item_row_clicked', { item_id: item.id, has_source_url: Boolean(item.sourceUrl) })
    if (item.sourceUrl) {
      window.open(item.sourceUrl, '_blank', 'noopener,noreferrer')
    }
  }

  return (
    <div
      className={`knowledge-item${hasLink ? ' knowledge-item--clickable' : ''}`}
      onClick={hasLink ? handleRowClick : undefined}
      role={hasLink ? 'link' : undefined}
      tabIndex={hasLink ? 0 : undefined}
      onKeyDown={
        hasLink
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                handleRowClick()
              }
            }
          : undefined
      }
    >
      <div className="knowledge-item__icon">{icon}</div>
      <div className="knowledge-item__content">
        <span className="knowledge-item__title">{displayTitle}</span>
      </div>
      <div className="knowledge-item__actions">
        {syncInfo}
        <Tooltip text={isSyncing ? 'Syncing…' : 'Re-sync'} position="top">
          <button
            className={`knowledge-item__resync-btn${isSyncing ? ' knowledge-item__resync-btn--syncing' : ''}`}
            onClick={(e) => {
              e.stopPropagation()
              track('knowledge_item_resynced', { item_id: item.id })
              onSync(item.connectorId ?? undefined, item.title ?? 'item')
            }}
            disabled={isSyncing}
            aria-label="Re-sync"
          >
            <RefreshCwIcon />
          </button>
        </Tooltip>
      </div>
    </div>
  )
}

// ─── Connector Group (synced items list) ──────────────────────────────────────

interface ConnectorGroupProps {
  items: KnowledgeItem[]
  onSync: (connectorId: string | undefined, name: string) => void
  syncingConnectorId: string | null
}

function ConnectorGroup({ items, onSync, syncingConnectorId }: ConnectorGroupProps) {
  const [expanded, setExpanded] = useState(false)
  const count = items.length
  const connectorId = items[0]?.connectorId ?? ''

  return (
    <div className="knowledge-group">
      <div className="knowledge-item">
        <button
          className="knowledge-group__toggle"
          onClick={() => {
            const next = !expanded
            track('knowledge_group_toggled', { connector_id: connectorId, expanded: next })
            setExpanded(next)
          }}
        >
          <span className="knowledge-group__toggle-label">
            {count} {count === 1 ? 'file' : 'files'}
          </span>
          <span className="pricing-plan-card__ou-chevron">
            <ChevronDownIcon
              width="14"
              height="14"
              style={{ display: 'block', transform: expanded ? 'none' : 'rotate(-90deg)', transition: 'transform 0.2s' }}
            />
          </span>
        </button>
      </div>
      {expanded && (
        <div className="knowledge-items">
          {items.map((item) => (
            <KnowledgeItemCard
              key={item.id}
              item={item}
              onSync={onSync}
              isSyncing={syncingConnectorId === item.connectorId}
            />
          ))}
        </div>
      )}
    </div>
  )
}

// ─── Main Page ─────────────────────────────────────────────────────────────────

export default function KnowledgePage() {
  const { showToast } = useToast()
  const { integrations, connected, isPending: integrationsPending } = useIntegrations()
  const viewedRef = useRef(false)
  // `integrations` is the catalog view (status is always 'available'/'planned')
  // after the multi-instance refactor — actually-connected rows live in
  // `connected`. Derive a type-keyed set so the card render functions can
  // tell whether any instance of this connector type is connected.
  const connectedTypes = new Set(connected.map((c) => c.connectorType ?? ''))
  const { data: items = [] } = useKnowledgeItems()

  const [filePickerIntegration, setFilePickerIntegration] = useState<Integration | null>(null)
  const [connectingIntegration, setConnectingIntegration] = useState<Integration | null>(null)
  const [syncingConnectorId, setSyncingConnectorId] = useState<string | null>(null)
  // Set when a confirm would remove files that teams pin. Holds the whole
  // pending change, so answering the warning applies exactly what was
  // confirmed rather than re-deriving it from a picker that has since reset.
  const [pendingRemoval, setPendingRemoval] = useState<PendingRemoval | null>(null)

  const { currentTenant: tenant } = useTenant()
  const batchCreate = useBatchCreateKnowledgeItems()
  const deleteItem = useDeleteKnowledgeItem()
  const syncMutation = useSyncItems()

  useEffect(() => {
    if (viewedRef.current) return
    viewedRef.current = true
    track('knowledge_viewed', {})
  }, [])

  // Per-section lists are built from two sources:
  //   - `connected` (one entry per LIVE connector instance) → renders the
  //     Connected cards. Distinct instances of the same type each get
  //     their own card with their own file picker / sync controls.
  //   - `integrations` (catalog, one per type) filtered to types that are
  //     NOT YET connected anywhere → renders the "+ Connect" cards. Once
  //     at least one instance is connected we still show the catalog
  //     entry as a "Connect another" card if the connector type supports
  //     multi-instance, but that's a separate UX (skipped here for now).
  const helpCenterConnected = connected.filter((c) =>
    HELP_CENTER_CONNECTOR_TYPES.has(c.connectorType ?? ''),
  )
  const documentConnected = connected.filter((c) =>
    DOCUMENT_CONNECTOR_TYPES.has(c.connectorType ?? ''),
  )
  const helpCenterAvailable = integrations.filter(
    (i) =>
      HELP_CENTER_CONNECTOR_TYPES.has(i.connectorType ?? '') &&
      i.status !== 'planned' &&
      !connectedTypes.has(i.connectorType ?? ''),
  )
  const documentAvailable = integrations.filter(
    (i) =>
      DOCUMENT_CONNECTOR_TYPES.has(i.connectorType ?? '') &&
      i.status !== 'planned' &&
      !connectedTypes.has(i.connectorType ?? ''),
  )

  // Group imported items by connector INSTANCE id (preferred) and by
  // connectorType (legacy fallback for items that pre-date the multi-instance
  // refactor and were stored without a per-instance connectorId).
  const itemsByConnectorId = items.reduce<Record<string, KnowledgeItem[]>>((acc, item) => {
    if (item.connectorId) (acc[item.connectorId] ??= []).push(item)
    return acc
  }, {})

  // What the open picker is managing: the library items that came from the
  // connector whose modal is up, and the external ids the picker checks
  // against. `externalId` is the connector's own file id, which is exactly what
  // a BrowseResult carries as `id` — the two id spaces line up because the add
  // path stores `externalId: r.id`.
  const pickerItems = filePickerIntegration?.connector?.id
    ? itemsByConnectorId[filePickerIntegration.connector.id] ?? []
    : []
  const pickerSelectedIds = pickerItems
    .map((i) => i.externalId)
    .filter((id): id is string => Boolean(id))

  const handleSync = async (connectorId: string | undefined, connectorName: string) => {
    if (connectorId) {
      setSyncingConnectorId(connectorId)
      const section: 'help_center' | 'documents' = HELP_CENTER_CONNECTOR_TYPES.has(
        connected.find((c) => c.connector?.id === connectorId)?.connectorType ?? '',
      ) ? 'help_center' : 'documents'
      track('knowledge_connector_resynced', { connector_id: connectorId, section })
    }
    try {
      const result = await syncMutation.mutateAsync(connectorId)
      showToast(`Synced ${result.synced} item${result.synced !== 1 ? 's' : ''}`, 'success')
    } catch {
      showToast(`Sync failed for ${connectorName}`, 'error')
    } finally {
      setSyncingConnectorId(null)
    }
  }

  // One confirm from the picker can both add and remove, so this runs the two
  // halves and reports what actually happened. Removals are resolved from
  // externalId (what the picker checks against) back to the knowledge item id
  // (what the delete endpoint takes).
  const handlePickerConfirm = async (
    newItems: CreateKnowledgeItemInput[],
    removedExternalIds: string[],
    connectorItems: KnowledgeItem[],
  ) => {
    const toDelete = removedExternalIds
      .map((externalId) => connectorItems.find((i) => i.externalId === externalId))
      .filter((item): item is KnowledgeItem => Boolean(item))

    // A file a team pins is part of how that team works, and removing it
    // changes what the team can answer with no other signal. Ask first. The
    // check is best-effort: if it cannot run we proceed rather than block a
    // removal on a warning lookup.
    if (toDelete.length > 0 && tenant?.id) {
      try {
        const pinned = (
          await Promise.all(
            toDelete.map(async (item) => ({
              item,
              teams: await getPinningTeams(tenant.id, item.id),
            })),
          )
        ).filter((entry) => entry.teams.length > 0)

        if (pinned.length > 0) {
          track('knowledge_pinned_removal_warned', { item_count: pinned.length })
          setPendingRemoval({ newItems, toDelete, pinned })
          return
        }
      } catch {
        // fall through to the removal
      }
    }

    await applyPickerChanges(newItems, toDelete)
  }

  const applyPickerChanges = async (
    newItems: CreateKnowledgeItemInput[],
    toDelete: KnowledgeItem[],
  ) => {
    let added = 0
    let removed = 0
    try {
      if (newItems.length > 0) {
        const result = await batchCreate.mutateAsync(newItems)
        added = result.created.length
      }
      // Sequential, not Promise.all: each delete optimistically rewrites the
      // same cached list, and concurrent writers would each snapshot the
      // pre-delete state and restore each other's rows on rollback.
      for (const item of toDelete) {
        await deleteItem.mutateAsync(item.id)
        removed++
      }
      showToast(describeChanges(added, removed), 'success')
      setPendingRemoval(null)
      setFilePickerIntegration(null)
    } catch {
      // Partial success is possible (the adds landed, a delete failed), so say
      // what got through rather than a flat failure.
      showToast(
        added > 0 || removed > 0
          ? `${describeChanges(added, removed)}, then hit an error. Some changes were not saved.`
          : 'Failed to save changes',
        'error',
      )
      setPendingRemoval(null)
    }
  }

  // Each Connected card is rendered for ONE concrete connector instance.
  // When a tenant has multiple instances of the same type (e.g. two Gmails,
  // two Drives) we get one card per instance, each with its own picker and
  // sync controls — items are grouped by connectorId so the right files
  // attach to the right account.
  const renderHelpCenterConnected = (connectedIntegration: Integration) => {
    const connectorId = connectedIntegration.connector?.id
    const connectorItems = connectorId
      ? itemsByConnectorId[connectorId] ?? []
      : []
    const itemCount = connectorItems.length
    const isSyncing = syncingConnectorId === connectorId
    const latestSync = connectorItems.map((i) => i.lastSyncedAt).filter(Boolean).sort().pop()
    const accountLabel = connectedAccountLabel(connectedIntegration.connector)

    return (
      <div key={connectedIntegration.id}>
        <div className="connection-card connection-card--connected">
          <div className="connection-card__icon">{connectedIntegration.icon}</div>
          <div className="connection-card__content">
            <h3 className="connection-card__name">{connectedIntegration.name}</h3>
            {accountLabel && (
              <span className="connection-card__type">{accountLabel}</span>
            )}
          </div>
          <div className="connection-card__action-group">
            {itemCount > 0 && (
              <span className="connection-card__sync-time">
                {itemCount} {itemCount === 1 ? 'article' : 'articles'}
              </span>
            )}
            {latestSync && (
              <span className="connection-card__sync-time">
                Synced {formatRelativeTime(latestSync)}
              </span>
            )}
            <Tooltip text={isSyncing ? 'Syncing…' : 'Re-sync'} position="top">
              <button
                className={`knowledge-item__resync-btn${isSyncing ? ' knowledge-item__resync-btn--syncing' : ''}`}
                onClick={() => handleSync(connectorId, connectedIntegration.name)}
                disabled={isSyncing}
                aria-label="Re-sync"
              >
                <RefreshCwIcon />
              </button>
            </Tooltip>
          </div>
        </div>
      </div>
    )
  }

  const renderHelpCenterAvailable = (integration: Integration) => (
    <div key={integration.id}>
      <div className="connection-card connection-card--available">
        <div className="connection-card__icon">{integration.icon}</div>
        <div className="connection-card__content">
          <h3 className="connection-card__name">{integration.name}</h3>
          <span className="connection-card__type">{integration.type}</span>
        </div>
        <button
          className="connection-card__connect"
          onClick={() => {
            const section: 'help_center' | 'documents' = HELP_CENTER_CONNECTOR_TYPES.has(integration.connectorType ?? '')
              ? 'help_center'
              : 'documents'
            track('knowledge_connect_clicked', {
              connector_type: integration.connectorType ?? '',
              section,
            })
            setConnectingIntegration(integration)
          }}
        >
          + Connect
        </button>
      </div>
    </div>
  )

  const renderDocumentConnected = (connectedIntegration: Integration) => {
    const connectorId = connectedIntegration.connector?.id
    const connectorItems = connectorId
      ? itemsByConnectorId[connectorId] ?? []
      : []
    const itemCount = connectorItems.length
    const isSyncing = syncingConnectorId === connectorId
    const accountLabel = connectedAccountLabel(connectedIntegration.connector)

    return (
      <div
        key={connectedIntegration.id}
        className={itemCount > 0 ? 'knowledge-card-with-group' : undefined}
      >
        <div className="connection-card connection-card--connected">
          <div className="connection-card__icon">{connectedIntegration.icon}</div>
          <div className="connection-card__content">
            <h3 className="connection-card__name">{connectedIntegration.name}</h3>
            {accountLabel && (
              <span className="connection-card__type">{accountLabel}</span>
            )}
          </div>
          <div className="connection-card__action-group">
            <button
              className={`connection-card__connect${itemCount > 0 ? ' connection-card__connect--reimport' : ''}`}
              onClick={() => {
                track('knowledge_file_picker_opened', {
                  connector_id: connectedIntegration.connector?.id ?? '',
                  connector_type: connectedIntegration.connectorType ?? '',
                })
                setFilePickerIntegration(connectedIntegration)
              }}
            >
              {itemCount > 0 ? 'Manage Files' : 'Select Files'}
            </button>
            {itemCount > 0 && (
              <Tooltip text={isSyncing ? 'Syncing…' : 'Re-sync'} position="top">
                <button
                  className={`knowledge-item__resync-btn${isSyncing ? ' knowledge-item__resync-btn--syncing' : ''}`}
                  onClick={() => handleSync(connectorId, connectedIntegration.name)}
                  disabled={isSyncing}
                  aria-label="Re-sync"
                >
                  <RefreshCwIcon />
                </button>
              </Tooltip>
            )}
          </div>
        </div>
        {itemCount > 0 && (
          <ConnectorGroup
            items={connectorItems}
            onSync={handleSync}
            syncingConnectorId={syncingConnectorId}
          />
        )}
      </div>
    )
  }

  const renderDocumentAvailable = (integration: Integration) => (
    <div key={integration.id}>
      <div className="connection-card connection-card--available">
        <div className="connection-card__icon">{integration.icon}</div>
        <div className="connection-card__content">
          <h3 className="connection-card__name">{integration.name}</h3>
          <span className="connection-card__type">{integration.type}</span>
        </div>
        <button
          className="connection-card__connect"
          onClick={() => {
            const section: 'help_center' | 'documents' = HELP_CENTER_CONNECTOR_TYPES.has(integration.connectorType ?? '')
              ? 'help_center'
              : 'documents'
            track('knowledge_connect_clicked', {
              connector_type: integration.connectorType ?? '',
              section,
            })
            setConnectingIntegration(integration)
          }}
        >
          + Connect
        </button>
      </div>
    </div>
  )

  // Skeleton rows inside a knowledge-source-group
  const renderGroupSkeletons = (count: number) => (
    <>
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="connection-card connection-card--available">
          <div className="connection-card__icon skeleton-pulse" style={{ borderRadius: 10 }} />
          <div className="connection-card__content">
            <div className="skeleton-text skeleton-text--title skeleton-pulse" style={{ width: 120 }} />
          </div>
          <div className="skeleton-button skeleton-pulse" />
        </div>
      ))}
    </>
  )

  return (
    <>
      <div className="knowledge-page">
        <PageHeader
          title="Knowledge"
          subtitle="Content your agent draws from when doing work."
        />

        {/* ── Help Center ───────────────────────────────────────────────── */}
        <div className="knowledge-source-group">
          <div className="capability-group__header">
            <h3 className="connection-card__name">Help Center</h3>
          </div>
          {integrationsPending ? (
            renderGroupSkeletons(2)
          ) : (
            <>
              {helpCenterConnected.map(renderHelpCenterConnected)}
              {helpCenterAvailable.map(renderHelpCenterAvailable)}
            </>
          )}
        </div>

        {/* ── Documents ─────────────────────────────────────────────────── */}
        <div className="knowledge-source-group">
          <div className="capability-group__header">
            <h3 className="connection-card__name">Documents</h3>
          </div>
          {integrationsPending ? (
            renderGroupSkeletons(3)
          ) : (
            <>
              {documentConnected.map(renderDocumentConnected)}
              {documentAvailable.map(renderDocumentAvailable)}
            </>
          )}
        </div>

      </div>

      {/* File picker modal */}
      {filePickerIntegration?.connector && (
        <ModalOverlay onClose={() => setFilePickerIntegration(null)}>
          <div className="knowledge-modal">
            <div className="knowledge-modal__header">
              <span className="knowledge-modal__icon">
                {getIntegrationIcon(filePickerIntegration.connectorType ?? '')}
              </span>
              <h2 className="knowledge-modal__title">
                {pickerItems.length > 0
                  ? `Manage files from ${filePickerIntegration.name}`
                  : `Select files from ${filePickerIntegration.name}`}
              </h2>
            </div>
            <FilePicker
              connectorId={filePickerIntegration.connector.id}
              // What this connector has already put in the library. Checking
              // these is what lets the same modal take a file back out.
              alreadySelectedIds={pickerSelectedIds}
              onSelect={(results: BrowseResult[], removedIds: string[]) => {
                const connectorId = filePickerIntegration.connector?.id
                if (!connectorId) return
                const connectorType = filePickerIntegration.connectorType ?? ''
                // Returned so callers (and tests) can await the whole confirm,
                // which now includes the pinned-file lookup before any write.
                return handlePickerConfirm(
                  results.map((r) => ({
                    title: r.title,
                    sourceUrl: r.url ?? undefined,
                    connectorId,
                    connectorType,
                    externalId: r.id,
                    contentType: (r.contentType as CreateKnowledgeItemInput['contentType']) ?? 'document',
                    excerpt: r.excerpt ?? undefined,
                    importMode: 'file_select' as const,
                  })),
                  removedIds,
                  pickerItems,
                )
              }}
              onClose={() => setFilePickerIntegration(null)}
              isBusy={batchCreate.isPending || deleteItem.isPending}
            />
          </div>
        </ModalOverlay>
      )}

      {/* Pinned-file warning. Sits over the picker: answering it either applies
          the change that was already confirmed, or drops it and leaves the
          library as it was. */}
      {pendingRemoval && (
        <ModalOverlay onClose={() => setPendingRemoval(null)}>
          <div className="knowledge-modal knowledge-modal--confirm">
            <div className="knowledge-modal__header">
              <h2 className="knowledge-modal__title">
                {pendingRemoval.pinned.length === 1
                  ? 'This file is in use'
                  : 'These files are in use'}
              </h2>
            </div>
            <p className="knowledge-confirm__lead">
              Removing {pendingRemoval.pinned.length === 1 ? 'it' : 'them'} takes the content
              away from teams that were set up to rely on it.
            </p>
            <ul className="knowledge-confirm__list">
              {pendingRemoval.pinned.map(({ item, teams }) => (
                <li key={item.id} className="knowledge-confirm__row">
                  <span className="knowledge-confirm__file">{item.title}</span>
                  <span className="knowledge-confirm__teams">
                    Pinned by {listTeamNames(teams)}
                  </span>
                </li>
              ))}
            </ul>
            <div className="knowledge-confirm__actions">
              <Button variant="outline" onClick={() => setPendingRemoval(null)}>
                Keep files
              </Button>
              <Button
                variant="destructive"
                disabled={batchCreate.isPending || deleteItem.isPending}
                onClick={() => {
                  track('knowledge_pinned_removal_confirmed', {
                    item_count: pendingRemoval.pinned.length,
                  })
                  applyPickerChanges(pendingRemoval.newItems, pendingRemoval.toDelete)
                }}
              >
                Remove anyway
              </Button>
            </div>
          </div>
        </ModalOverlay>
      )}

      {/* OAuth connection modal */}
      {connectingIntegration && (
        <ConnectIntegrationModal
          integration={connectingIntegration}
          onClose={() => setConnectingIntegration(null)}
        />
      )}
    </>
  )
}
