import { useState, useEffect, useMemo } from 'react'
import Button from './Button'
import Checkbox from './Checkbox/Checkbox'
import TextInput from './TextInput/TextInput'
import ConnectIntegrationModal from './ConnectIntegrationModal'
import ModalOverlay from './ModalOverlay'
import Tooltip from './Tooltip'
import { useIntegrations, type Integration } from '../hooks/useIntegrations'
import { getIntegrationIcon } from './icons/integrationIconRegistry'
import { useExternalAgents } from '../hooks/useExternalAgents'
import { useInternalAgents } from '../hooks/useInternalAgents'
import type { InternalAgent } from '../services/internalAgents'
import type { CollaborationMode } from '../services/externalAgents'
import { connectedAccountLabel } from '../utils/connectedAccountLabel'
import { validateBindingFilter } from '../utils/validateBindingFilter'
import { parseOutlookAqs, aqsToOData } from '../utils/outlookFilter'
import { useToast } from '../contexts/ToastContext'
import CheckIcon from '../assets/icons/check.svg?react'
import PlugIcon from '../assets/icons/plug.svg?react'
import TeamIcon from '../assets/icons/team.svg?react'
import PlusIcon from '../assets/icons/plus.svg?react'
import ChevronDownIcon from '../assets/icons/chevron-down.svg?react'

type ExpandedField = 'filter' | 'reply' | null

type ModalState = { type: 'connect'; integration: Integration } | { type: 'select'; integration: Integration } | null

const DEFAULT_CHIPS_LIMIT = 9

// Richer integration selection that tracks which objects are selected
export interface SelectedIntegration {
  id: string
  integrationId?: string
  name: string
  type: string
  selectedObjects: string[]  // Empty array means "all objects" / full access
  collaborationMode?: CollaborationMode
  /**
   * Per-connector-type binding config.
   *   - Gmail   (connectorType='google_mail'):            { gmailQuery?, sendAs? }
   *   - Outlook (connectorType='microsoft_outlook_mail'): { outlookFilter?, sendAs? }
   * Omitted when no options are set.
   */
  config?: Record<string, unknown>
}

interface IntegrationsSelectorProps {
  selected: SelectedIntegration[]
  onChange: (selected: SelectedIntegration[]) => void
  title?: string
  titleAs?: 'h1' | 'h2' | 'h3'
  titleClassName?: string
  chipsLimit?: number
}

export default function IntegrationsSelector({
  selected,
  onChange,
  title,
  titleAs: TitleTag = 'h2',
  titleClassName,
  chipsLimit = DEFAULT_CHIPS_LIMIT
}: IntegrationsSelectorProps) {
  const { showToast } = useToast()
  const [modal, setModal] = useState<ModalState>(null)
  const [search, setSearch] = useState('')
  // Track checkbox state for the current modal
  const [checkedObjects, setCheckedObjects] = useState<Set<string>>(new Set())
  // Per-binding mail-connector options. Only meaningful when the modal is for
  // a connector that surfaces these fields (Gmail or Outlook today). `sendAs`
  // is shared across both — Gmail Send-as alias vs. Outlook shared mailbox.
  const [gmailQuery, setGmailQuery] = useState<string>('')
  const [outlookFilter, setOutlookFilter] = useState<string>('')
  const [sendAs, setSendAs] = useState<string>('')
  // Outer "More options" disclosure — entire accordion is hidden until the user
  // asks to see it (or auto-revealed when the modal opens with saved config).
  const [showMoreOptions, setShowMoreOptions] = useState<boolean>(false)
  // Inner mutually-exclusive accordion — only one of Filter / Reply from open
  // at a time. Both default collapsed; the field with saved content is the one
  // pre-expanded in edit mode.
  const [expandedField, setExpandedField] = useState<ExpandedField>(null)

  // Get integrations with live connection status
  const { connected, available, isPending } = useIntegrations()

  // Get all external agents (all statuses — disconnected/error shown as muted)
  const { data: externalAgentsData, isPending: agentsPending } = useExternalAgents()
  // Memoized because `?? []` mints a new array every render, which would make
  // every memo keyed on it recompute every render.
  const externalAgents = useMemo(() => externalAgentsData?.agents ?? [], [externalAgentsData?.agents])

  // Get active internal agents for peer collaborator selection
  const {
    data: internalAgentsData,
    isPending: internalAgentsPending,
    fetchNextPage,
    hasNextPage,
  } = useInternalAgents({ status: 'active' })
  // Same reason: flatMap builds a new array every render.
  const internalAgents = useMemo(
    () => internalAgentsData?.pages.flatMap(p => p.internalAgents) ?? [],
    [internalAgentsData?.pages],
  )

  // Drain all pages so tenants with many agents don't silently miss collaborators
  useEffect(() => {
    if (hasNextPage) fetchNextPage()
  }, [hasNextPage, fetchNextPage])

  // Dynamic title based on whether any collaborators exist
  const displayTitle = title ?? (externalAgents.length > 0 || internalAgents.length > 0
    ? 'Who and what should they work with?'
    : 'What should they work with?')

  const isSearching = search.trim().length > 0

  const filterBySearch = (integrations: Integration[]) => {
    if (!search.trim()) return integrations
    const query = search.toLowerCase()
    return integrations.filter(i =>
      i.name.toLowerCase().includes(query) ||
      i.type.toLowerCase().includes(query)
    )
  }

  const filterAgentsBySearch = (agents: typeof externalAgents) => {
    if (!search.trim()) return agents
    const query = search.toLowerCase()
    return agents.filter(a =>
      a.name.toLowerCase().includes(query) ||
      (a.description && a.description.toLowerCase().includes(query))
    )
  }

  const filterInternalAgentsBySearch = (agents: InternalAgent[]) => {
    if (!search.trim()) return agents
    const query = search.toLowerCase()
    return agents.filter(a =>
      a.role.toLowerCase().includes(query) ||
      (a.summary && a.summary.toLowerCase().includes(query))
    )
  }

  const getIntegrationKey = (integration: Integration) => integration.connector?.id || integration.id
  const isSelected = (idOrIntegration: string | Integration) => {
    if (typeof idOrIntegration === 'string') {
      return selected.some(s => s.id === idOrIntegration)
    }
    const key = getIntegrationKey(idOrIntegration)
    return selected.some(s => s.id === key)
  }

  const handleIntegrationClick = (integration: Integration) => {
    if (integration.status === 'planned') {
      return
    }
    if (integration.status === 'connected') {
      const key = getIntegrationKey(integration)
      const existing = selected.find((s) => s.id === key)
      // Re-clicking a selected connector deselects it — no edit modal, no
      // Remove button. Users who want to change options remove and re-add.
      if (existing) {
        onChange(selected.filter((s) => s.id !== key))
        return
      }
      // No enumerable objects (e.g. MCP servers that expose "all available
      // data" as a single bucket): the modal would have nothing to pick, so
      // skip it and toggle selection directly. selectedObjects=[] means
      // full access.
      if (integration.objectsCovered.length === 0) {
        onChange([
          ...selected,
          {
            id: key,
            integrationId: integration.connectorType ?? integration.id,
            name: integration.name,
            type: integration.type,
            selectedObjects: [],
          },
        ])
        return
      }
      // Open modal in add mode — all objects checked, fields blank.
      setCheckedObjects(new Set(integration.objectsCovered))
      setGmailQuery('')
      setOutlookFilter('')
      setSendAs('')
      setShowMoreOptions(false)
      setExpandedField(null)
      setModal({ type: 'select', integration })
    } else if (integration.status === 'available' || integration.status === 'needs_reconnect') {
      // Both flows reuse the same OAuth modal — `/connections` already routes
      // Reconnect through the connect modal, so we mirror that here instead of
      // forcing a navigation.
      setModal({ type: 'connect', integration })
    }
  }

  const handleCollaboratorClick = (agent: { id: string; name: string }) => {
    if (isSelected(agent.id)) {
      onChange(selected.filter(s => s.id !== agent.id))
    } else {
      onChange([...selected, {
        id: agent.id,
        name: agent.name,
        type: 'collaborator',
        selectedObjects: []
      }])
    }
  }

  const handleInternalAgentClick = (agent: InternalAgent) => {
    if (isSelected(agent.id)) {
      onChange(selected.filter(s => s.id !== agent.id))
    } else {
      onChange([...selected, {
        id: agent.id,
        name: agent.role,
        type: 'collaborator',
        selectedObjects: [],
        collaborationMode: 'two_way',
      }])
    }
  }

  const handleSelectData = () => {
    if (modal?.integration) {
      const integration = modal.integration
      const allObjects = integration.objectsCovered
      const selectedObjects = Array.from(checkedObjects)

      // If all objects are selected, store empty array (means "full access")
      const objectsToStore = selectedObjects.length === allObjects.length ? [] : selectedObjects

      // Non-blocking warning: filter falls outside the routing-time supported
      // subset. Save still proceeds — the agent's explicit list_messages calls
      // work either way; only the event-routing predicate may skip matches.
      //
      // Gmail uses the same syntax users type in the Gmail search bar, so it
      // is validated and stored verbatim. Outlook users type AQS (`from:`,
      // `to:`, `category:`) but Microsoft Graph requires OData $filter — we
      // parse the AQS here and translate to OData for storage; the toast
      // fires if the AQS doesn't parse.
      let outlookOData: string | null = null
      if (integration.connectorType === 'google_mail' && gmailQuery) {
        if (!validateBindingFilter('google_mail', gmailQuery).ok) {
          showToast('Invalid filter. Some matches may be skipped.', 'error')
        }
      } else if (integration.connectorType === 'microsoft_outlook_mail' && outlookFilter) {
        const parsed = parseOutlookAqs(outlookFilter)
        if (parsed.ok && parsed.tokens) {
          outlookOData = aqsToOData(parsed.tokens)
        } else {
          showToast('Invalid filter. Some matches may be skipped.', 'error')
        }
      }

      const config =
        integration.connectorType === 'google_mail' && (gmailQuery || sendAs)
          ? {
              ...(gmailQuery ? { gmailQuery } : {}),
              ...(sendAs ? { sendAs } : {}),
            }
          : integration.connectorType === 'microsoft_outlook_mail' && (outlookOData || sendAs)
          ? {
              ...(outlookOData ? { outlookFilter: outlookOData } : {}),
              ...(sendAs ? { sendAs } : {}),
            }
          : undefined

      const key = integration.connector?.id || integration.id
      const newSelection: SelectedIntegration = {
        id: key,
        integrationId: integration.connectorType ?? integration.id,
        name: integration.name,
        type: integration.type,
        selectedObjects: objectsToStore,
        ...(config ? { config } : {}),
      }
      onChange([...selected, newSelection])
    }
    setModal(null)
  }

  const handleCheckboxChange = (object: string, checked: boolean) => {
    setCheckedObjects(prev => {
      const next = new Set(prev)
      if (checked) {
        next.add(object)
      } else {
        next.delete(object)
      }
      return next
    })
  }

  const allConnected = filterBySearch(connected)
  const allAvailable = filterBySearch(available)
  const allCollaborators = filterAgentsBySearch(externalAgents)
  const allInternalAgents = filterInternalAgentsBySearch(internalAgents)

  // Bound connectors first so they don't get hidden behind "+ N more" when the
  // user has many connected apps but only a few bound to this agent.
  const orderedConnected = isSearching
    ? allConnected
    : [...allConnected].sort((a, b) => Number(isSelected(b)) - Number(isSelected(a)))

  const visibleConnected = isSearching ? allConnected : orderedConnected.slice(0, chipsLimit)
  const hiddenConnectedCount = isSearching ? 0 : Math.max(0, orderedConnected.length - chipsLimit)

  const visibleAvailable = isSearching ? allAvailable : allAvailable.slice(0, chipsLimit)
  const hiddenAvailableCount = isSearching ? 0 : Math.max(0, allAvailable.length - chipsLimit)

  const visibleCollaborators = isSearching ? allCollaborators : allCollaborators.slice(0, chipsLimit)
  const hiddenCollaboratorsCount = isSearching ? 0 : Math.max(0, allCollaborators.length - chipsLimit)

  const visibleInternalAgents = isSearching ? allInternalAgents : allInternalAgents.slice(0, chipsLimit)
  const hiddenInternalAgentsCount = isSearching ? 0 : Math.max(0, allInternalAgents.length - chipsLimit)

  // Selections that no longer resolve to anything on offer.
  //
  // A binding survives its connector being disconnected — deliberately, so the
  // Teams page can say which capability an agent lost instead of silently
  // dropping an icon. The cost lands here: the chip list is built from live
  // connectors, so a binding whose connector is gone renders nothing at all.
  // It stayed in the array, got resubmitted on every save, and could not be
  // removed because there was no chip to click.
  //
  // Resolution mirrors the runtime and the Teams badge: an id that matches a
  // live connector is fine, and so is one that does not when exactly one live
  // connector of that type exists, because that is a reconnect under a new id
  // and the runtime binds it by type. Peer-agent selections are excluded —
  // they point at agents, not connectors, and are handled by their own
  // sections above.
  const orphanedSelections = useMemo(() => {
    if (isPending || agentsPending || internalAgentsPending) return []
    const liveKeys = new Set(connected.map(getIntegrationKey))
    const liveIds = new Set(connected.map(i => i.connector?.id).filter(Boolean) as string[])
    const liveTypeCounts = new Map<string, number>()
    for (const i of connected) {
      if (!i.connectorType) continue
      liveTypeCounts.set(i.connectorType, (liveTypeCounts.get(i.connectorType) ?? 0) + 1)
    }
    const peerIds = new Set<string>([
      ...externalAgents.map(a => a.id),
      ...internalAgents.map(a => a.id),
    ])

    const selectedTypeCounts = new Map<string, number>()
    for (const sel of selected) {
      if (sel.integrationId) {
        selectedTypeCounts.set(sel.integrationId, (selectedTypeCounts.get(sel.integrationId) ?? 0) + 1)
      }
    }

    return selected.filter(sel => {
      if (peerIds.has(sel.id)) return false
      if (liveKeys.has(sel.id) || liveIds.has(sel.id)) return false
      const type = sel.integrationId
      if (!type) return false
      if ((liveTypeCounts.get(type) ?? 0) === 1 && selectedTypeCounts.get(type) === 1) return false
      return true
    })
  }, [selected, connected, externalAgents, internalAgents, isPending, agentsPending, internalAgentsPending])

  const removeOrphan = (id: string) => {
    onChange(selected.filter(s => s.id !== id))
  }

  const hasNoResults = search.trim() && allConnected.length === 0 && allAvailable.length === 0 && allCollaborators.length === 0 && allInternalAgents.length === 0

  // Show skeleton chips while integrations are loading. The skeleton pulse is
  // the loading indicator — no separate spinner needed.
  if (isPending || agentsPending || internalAgentsPending) {
    return (
      <>
        {displayTitle && <TitleTag className={titleClassName}>{displayTitle}</TitleTag>}
        <div className="integrations-sections">
          <div className="integrations-section">
            <div className="integrations-chips">
              {[1, 2, 3, 4, 5].map(i => (
                <div key={i} className="integration-chip integration-chip--skeleton">
                  <span className="integration-chip__icon skeleton-pulse" />
                  <span className="skeleton-text skeleton-pulse" style={{ width: '60px' }} />
                </div>
              ))}
            </div>
          </div>
        </div>
      </>
    )
  }

  return (
    <>
      {displayTitle && <TitleTag className={titleClassName}>{displayTitle}</TitleTag>}
      {hasNoResults ? (
        <div className="integrations-empty">
          <h3 className="integrations-empty__title">Don't see your app?</h3>
          <p className="integrations-empty__text">Tell us what you would like to connect.</p>
          <Button variant="outline" href={`mailto:support@example.com?subject=${encodeURIComponent(`New App Request: ${search.trim()}`)}`}>
            Request App
          </Button>
        </div>
      ) : (
        <div className="integrations-sections">
          {visibleConnected.length > 0 && (
            <div className="integrations-section">
              <span className="integrations-section__label">Connected</span>
              <div className="integrations-chips">
                {visibleConnected.map(integration => {
                  const checked = isSelected(integration)
                  const needsReconnect = integration.status === 'needs_reconnect'
                  const accountLabel = connectedAccountLabel(integration.connector)
                  // Tooltip lets the user disambiguate multiple connectors of the
                  // same type (e.g. two Gmail accounts). For needs_reconnect we
                  // suffix a hint so the user knows clicking will start reconnect.
                  const tooltipText = needsReconnect
                    ? (accountLabel ? `${accountLabel} — needs reconnect` : 'Needs reconnect')
                    : accountLabel
                  const chip = (
                    <button
                      key={integration.id}
                      type="button"
                      className={`integration-chip ${checked ? 'integration-chip--selected' : ''}`}
                      onClick={() => handleIntegrationClick(integration)}
                    >
                      <span className="integration-chip__icon">{integration.icon}</span>
                      {integration.name}
                      {checked && (
                        <CheckIcon width={14} height={14} />
                      )}
                    </button>
                  )
                  return tooltipText ? (
                    <Tooltip key={integration.id} text={tooltipText} position="top">
                      {chip}
                    </Tooltip>
                  ) : chip
                })}
                {hiddenConnectedCount > 0 && (
                  <span className="integrations-more">+{hiddenConnectedCount} more</span>
                )}
              </div>
            </div>
          )}

          {orphanedSelections.length > 0 && (
            <div className="integrations-section">
              <span className="integrations-section__label">Needs attention</span>
              <div className="integrations-chips">
                {orphanedSelections.map(sel => (
                  <Tooltip
                    key={sel.id}
                    text={`${sel.name || sel.integrationId} is no longer connected. Reconnect it, or remove it from this agent.`}
                    position="top"
                  >
                    <button
                      type="button"
                      className="integration-chip integration-chip--broken"
                      onClick={() => removeOrphan(sel.id)}
                      aria-label={`Remove ${sel.name || sel.integrationId} from this agent`}
                    >
                      <span className="integration-chip__icon">
                        {getIntegrationIcon(sel.integrationId ?? '')}
                      </span>
                      {sel.name || sel.integrationId}
                      <span className="integration-chip__remove" aria-hidden="true">×</span>
                    </button>
                  </Tooltip>
                ))}
              </div>
            </div>
          )}

          {(visibleInternalAgents.length > 0 || visibleCollaborators.length > 0) && (
            <div className="integrations-section">
              <span className="integrations-section__label">Collaborators</span>
              <div className="integrations-chips">
                {visibleInternalAgents.map(agent => {
                  const checked = isSelected(agent.id)
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      className={`integration-chip ${checked ? 'integration-chip--selected' : ''}`}
                      onClick={() => handleInternalAgentClick(agent)}
                      title={agent.summary || undefined}
                    >
                      <span className="integration-chip__icon">
                        <TeamIcon width={16} height={16} style={{ stroke: 'var(--color-gray-400)' }} />
                      </span>
                      {agent.role}
                      {checked && <CheckIcon width={14} height={14} />}
                    </button>
                  )
                })}
                {visibleCollaborators.map(agent => {
                  const isConnected = agent.status === 'connected'
                  const isAwaitingConnection = agent.status === 'pending' || agent.status === 'pending_review'
                  const checked = isConnected && isSelected(agent.id)
                  const disabledTitle = isAwaitingConnection
                    ? 'Connection pending'
                    : 'Reconnect in Settings → Connections to activate'
                  return (
                    <button
                      key={agent.id}
                      type="button"
                      className={`integration-chip ${checked ? 'integration-chip--selected' : ''} ${!isConnected ? 'integration-chip--disabled' : ''}`}
                      onClick={() => isConnected && handleCollaboratorClick(agent)}
                      title={isConnected ? (agent.description || undefined) : disabledTitle}
                      disabled={!isConnected}
                    >
                      <span className="integration-chip__icon">
                        <PlugIcon width={16} height={16} style={{ stroke: 'var(--color-gray-400)' }} />
                      </span>
                      {agent.name}
                      {checked && <CheckIcon width={14} height={14} />}
                    </button>
                  )
                })}
                {(hiddenInternalAgentsCount + hiddenCollaboratorsCount) > 0 && (
                  <span className="integrations-more">+{hiddenInternalAgentsCount + hiddenCollaboratorsCount} more</span>
                )}
              </div>
            </div>
          )}

          {visibleAvailable.length > 0 && (
            <div className="integrations-section">
              <span className="integrations-section__label">Available</span>
              <div className="integrations-chips">
                {visibleAvailable.map(integration => {
                  const checked = isSelected(integration)
                  return (
                    <button
                      key={integration.id}
                      type="button"
                      className={`integration-chip integration-chip--available ${checked ? 'integration-chip--selected' : ''}`}
                      onClick={() => handleIntegrationClick(integration)}
                    >
                      <span className="integration-chip__icon">{integration.icon}</span>
                      {integration.name}
                      {checked ? (
                        <CheckIcon width={14} height={14} />
                      ) : (
                        <PlusIcon width={12} height={12} />
                      )}
                    </button>
                  )
                })}
                {hiddenAvailableCount > 0 && (
                  <span className="integrations-more">+{hiddenAvailableCount} more</span>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      <TextInput
        variant="search"
        className="integrations-search"
        placeholder="Search"
        value={search}
        onChange={e => setSearch(e.target.value)}
      />

      {/* Connect Modal */}
      {modal?.type === 'connect' && (
        <ConnectIntegrationModal
          integration={modal.integration}
          onClose={() => setModal(null)}
        />
      )}

      {/* Select Data Modal */}
      {modal?.type === 'select' && (
        <ModalOverlay onClose={() => setModal(null)}>
          <div className="integration-modal__icon">{modal.integration.icon}</div>
          <h2 className="integration-modal__title">Select {modal.integration.name} Data</h2>
          <p className="integration-modal__description">
            Choose which data from {modal.integration.name} your team should have access to.
          </p>
          <div className="integration-modal__options">
            {modal.integration.objectsCovered.length > 0 ? (
              modal.integration.objectsCovered.map((object) => (
                <div key={object} className="integration-modal__option">
                  <Checkbox
                    checked={checkedObjects.has(object)}
                    onChange={(checked) => handleCheckboxChange(object, checked)}
                    label={object}
                  />
                </div>
              ))
            ) : (
              <div className="integration-modal__option">
                <Checkbox checked disabled onChange={() => {}} label="All available data" />
              </div>
            )}
          </div>
          {modal.integration.connectorType === 'google_mail' && (() => {
            const toggle = (f: ExpandedField) =>
              setExpandedField((prev) => (prev === f ? null : f))
            return (
              <div className="integration-modal__fields">
                <button
                  type="button"
                  className="integration-modal__disclosure"
                  onClick={() => setShowMoreOptions((v) => !v)}
                  aria-expanded={showMoreOptions}
                >
                  {showMoreOptions ? 'Hide options' : 'More options'}
                </button>
                {showMoreOptions && <>
                <div className="integration-modal__collapsible">
                  <button
                    type="button"
                    className="integration-modal__collapsible-header"
                    onClick={() => toggle('filter')}
                    aria-expanded={expandedField === 'filter'}
                  >
                    <span>Filter</span>
                    <ChevronDownIcon
                      width={16}
                      height={16}
                      className={`integration-modal__chevron ${expandedField === 'filter' ? 'integration-modal__chevron--open' : ''}`}
                    />
                  </button>
                  <div className="integration-modal__collapsible-panel" hidden={expandedField !== 'filter'}>
                    <TextInput
                      type="text"
                      placeholder="e.g. label:work or work@acme.com"
                      value={gmailQuery}
                      onChange={(e) => setGmailQuery(e.target.value)}
                    />
                    <p className="integration-modal__field-help">
                      Limits what the agent sees and replies to. Leave blank for the full inbox.
                      Supported syntax: <code>label:</code>, <code>to:</code>, <code>from:</code>.
                    </p>
                  </div>
                </div>
                <div className="integration-modal__collapsible">
                  <button
                    type="button"
                    className="integration-modal__collapsible-header"
                    onClick={() => toggle('reply')}
                    aria-expanded={expandedField === 'reply'}
                  >
                    <span>Reply from</span>
                    <ChevronDownIcon
                      width={16}
                      height={16}
                      className={`integration-modal__chevron ${expandedField === 'reply' ? 'integration-modal__chevron--open' : ''}`}
                    />
                  </button>
                  <div className="integration-modal__collapsible-panel" hidden={expandedField !== 'reply'}>
                    <TextInput
                      type="email"
                      placeholder="e.g. amy@acme.com"
                      value={sendAs}
                      onChange={(e) => setSendAs(e.target.value)}
                    />
                    <p className="integration-modal__field-help">
                      Use a verified Gmail “Send mail as” alias. Add one in Gmail Settings → Accounts → Send mail as.
                    </p>
                  </div>
                </div>
                </>}
              </div>
            )
          })()}
          {modal.integration.connectorType === 'microsoft_outlook_mail' && (() => {
            const toggle = (f: ExpandedField) =>
              setExpandedField((prev) => (prev === f ? null : f))
            return (
              <div className="integration-modal__fields">
                <button
                  type="button"
                  className="integration-modal__disclosure"
                  onClick={() => setShowMoreOptions((v) => !v)}
                  aria-expanded={showMoreOptions}
                >
                  {showMoreOptions ? 'Hide options' : 'More options'}
                </button>
                {showMoreOptions && <>
                <div className="integration-modal__collapsible">
                  <button
                    type="button"
                    className="integration-modal__collapsible-header"
                    onClick={() => toggle('filter')}
                    aria-expanded={expandedField === 'filter'}
                  >
                    <span>Filter</span>
                    <ChevronDownIcon
                      width={16}
                      height={16}
                      className={`integration-modal__chevron ${expandedField === 'filter' ? 'integration-modal__chevron--open' : ''}`}
                    />
                  </button>
                  <div className="integration-modal__collapsible-panel" hidden={expandedField !== 'filter'}>
                    <TextInput
                      type="text"
                      placeholder="e.g. from:work@acme.com or category:work"
                      value={outlookFilter}
                      onChange={(e) => setOutlookFilter(e.target.value)}
                    />
                    <p className="integration-modal__field-help">
                      Limits what the agent sees and replies to. Leave blank for the full inbox.
                      Supported syntax: <code>from:</code>, <code>to:</code>, <code>category:</code>.
                    </p>
                  </div>
                </div>
                <div className="integration-modal__collapsible">
                  <button
                    type="button"
                    className="integration-modal__collapsible-header"
                    onClick={() => toggle('reply')}
                    aria-expanded={expandedField === 'reply'}
                  >
                    <span>Reply from</span>
                    <ChevronDownIcon
                      width={16}
                      height={16}
                      className={`integration-modal__chevron ${expandedField === 'reply' ? 'integration-modal__chevron--open' : ''}`}
                    />
                  </button>
                  <div className="integration-modal__collapsible-panel" hidden={expandedField !== 'reply'}>
                    <TextInput
                      type="email"
                      placeholder="e.g. amy@acme.com"
                      value={sendAs}
                      onChange={(e) => setSendAs(e.target.value)}
                    />
                    <p className="integration-modal__field-help">
                      Use a Microsoft 365 shared mailbox you have Send-As permission on.
                      Reconnect Outlook once to grant the new permission.
                    </p>
                  </div>
                </div>
                </>}
              </div>
            )
          })()}
          <div className="integration-modal__actions">
            <Button variant="outline" onClick={() => setModal(null)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={handleSelectData} disabled={checkedObjects.size === 0}>
              Confirm
            </Button>
          </div>
        </ModalOverlay>
      )}
    </>
  )
}
