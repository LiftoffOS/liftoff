import { useState, useEffect, useRef } from 'react'
import { useAuth } from '../../contexts/AuthContext'
import { useToast } from '../../contexts/ToastContext'
import { Button, EmptyState, StatusDot, ModalOverlay, ConnectIntegrationModal, TextInput, PageHeader } from '../../components'
import ManageCustomMcpServerModal from '../../components/ManageCustomMcpServerModal'
import ManageCustomApiConnectionModal from '../../components/ManageCustomApiConnectionModal'
import { useDeleteConnector } from '../../hooks/useConnectors'
import { useIntegrations, type Integration } from '../../hooks/useIntegrations'
import { connectedAccountLabel } from '../../utils/connectedAccountLabel'
import { githubInstallConfig, hasGitHubApp, repositoryScopeLabel } from '../../utils/githubInstall'
import { useConnectorCatalog } from '../../hooks/useConnectorCatalog'
import PlusIcon from '../../assets/icons/plus.svg?react'
import { track } from '../../lib/analytics'
import './ConnectionsPage.css'
import './connectionCard.css'
// Connection-modal rules now live in the shared connectionModals.css (single
// source of truth, also used by ConnectIntegrationModal on the AgentBuilder/
// TeamUpdate pages). This page renders its own connection-management modal.
import '../../components/connectionModals.css'
import { PermissionGate } from '../../components/PermissionGate'

type ModalState = { type: 'connect'; integration: Integration } | { type: 'manage'; integration: Integration } | null

// Skeleton card component for loading state
/** Connection types that own a manage modal, and so are never sent to the
 *  connect flow just because they are broken: everything that repairs them,
 *  Disconnect included, lives in that modal. */
const SELF_MANAGED_CONNECTOR_TYPES = new Set(['custom_api_connector', 'custom_mcp_server'])

function SkeletonCard() {
  return (
    <div className="connection-card connection-card--skeleton">
      <div className="connection-card__icon skeleton-pulse" />
      <div className="connection-card__content">
        <div className="skeleton-text skeleton-text--title skeleton-pulse" />
        <div className="skeleton-text skeleton-text--subtitle skeleton-pulse" />
      </div>
      <div className="skeleton-button skeleton-pulse" />
    </div>
  )
}

export default function ConnectionsPage() {
  const { currentTenant: tenant } = useAuth()
  const { showToast } = useToast()
  const [modal, setModal] = useState<ModalState>(null)
  const [search, setSearch] = useState('')
  // Only ever true while a request is in flight, so the "not pending" half is
  // derived and the effect no longer has to switch it back off a frame late.
  const [skeletonDelayPassed, setSkeletonDelayPassed] = useState(false)
  const [isDisconnecting, setIsDisconnecting] = useState(false)
  const skeletonTimeoutRef = useRef<NodeJS.Timeout | null>(null)
  const viewedRef = useRef(false)
  const searchDebounceRef = useRef<NodeJS.Timeout | null>(null)

  // Get integrations with live connection status
  const { connected, pendingApproval, available, planned, isPending } = useIntegrations()
  const { supportsConnection } = useConnectorCatalog()

  // Mutation for disconnect
  const deleteConnectorMutation = useDeleteConnector()

  // Get tenantId from auth context
  const tenantId = tenant?.id

  // Never shown once the request has landed, whatever the timer did.
  const showSkeleton = isPending && skeletonDelayPassed

  // Delayed skeleton: only show after 150ms to avoid flash on fast loads
  useEffect(() => {
    if (isPending) {
      skeletonTimeoutRef.current = setTimeout(() => {
        setSkeletonDelayPassed(true)
      }, 150)
    } else if (skeletonTimeoutRef.current) {
      clearTimeout(skeletonTimeoutRef.current)
    }
    return () => {
      if (skeletonTimeoutRef.current) {
        clearTimeout(skeletonTimeoutRef.current)
      }
    }
  }, [isPending])

  useEffect(() => {
    if (viewedRef.current || isPending) return
    viewedRef.current = true
    track('connections_viewed', {
      connected_count: connected.length,
      available_count: available.length,
      planned_count: planned.length,
    })
  }, [isPending, connected.length, available.length, planned.length])

  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    if (!search) return
    searchDebounceRef.current = setTimeout(() => {
      track('connections_searched', { query_length: search.length })
    }, 300)
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current)
    }
  }, [search])

  const filterBySearch = (integrations: Integration[]) => {
    if (!search.trim()) return integrations
    const query = search.toLowerCase()
    return integrations.filter(i =>
      i.name.toLowerCase().includes(query) ||
      i.type.toLowerCase().includes(query)
    )
  }

  // Requested-but-not-yet-approved installs lead the Connected section: an
  // outstanding request is the thing the user most needs to see, and it has no
  // other home on this page.
  const connectedIntegrations = [
    ...filterBySearch(pendingApproval),
    ...filterBySearch(connected),
  ]
  const availableIntegrations = filterBySearch(available)
  const plannedIntegrations = filterBySearch(planned)

  const hasNoResults = search.trim() &&
    connectedIntegrations.length === 0 &&
    availableIntegrations.length === 0 &&
    plannedIntegrations.length === 0

  const handleDisconnect = async () => {
    // Fires from either the manage modal OR the reconnect (type: 'connect')
    // modal — both carry a live connector to remove. setModal(null) below
    // closes whichever one is open.
    if (!modal || !modal.integration.connector || !tenantId) return

    const { connector } = modal.integration
    setIsDisconnecting(true)

    try {
      await deleteConnectorMutation.mutateAsync(connector.id)
      track('connection_disconnected', { connector: modal.integration.connectorType ?? '' })
      setModal(null)
      setIsDisconnecting(false)
      showToast(`Disconnected ${modal.integration.name}`, 'success')
    } catch (error) {
      console.error('Failed to disconnect:', error)
      showToast('Failed to disconnect. Please try again.', 'error')
      setIsDisconnecting(false)
    }
  }

  return (
    <>
      <div className="connections-page">
        <PageHeader title="Connections" subtitle="Manage the apps and services connected to Liftoff" />

        <TextInput
          variant="search"
          className="connections-page__search"
          placeholder="Search"
          value={search}
          onChange={e => setSearch(e.target.value)}
        />

        {hasNoResults ? (
          <EmptyState
            title="Don't see your app?"
            description="Tell us what you would like to connect."
            action={
              <Button
                variant="outline"
                href={`mailto:support@example.com?subject=${encodeURIComponent(`App Request: ${search.trim()}`)}`}
                onClick={() => {
                  track('connections_request_app_clicked', { search_query: search.trim() })
                  track('connection_app_requested', { search_query: search.trim() })
                }}
              >
                Request App
              </Button>
            }
          />
        ) : showSkeleton ? (
          <div className="connections-page__sections">
            <section className="connections-section">
              <div className="connections-section__header">
                <div className="skeleton-text skeleton-text--section-title skeleton-pulse" />
              </div>
              <div className="connections-grid">
                {[1, 2, 3, 4, 5, 6].map(i => (
                  <SkeletonCard key={i} />
                ))}
              </div>
            </section>
          </div>
        ) : (
          <div className="connections-page__sections">
          {connectedIntegrations.length > 0 && (
            <section className="connections-section">
              <div className="connections-section__header">
                <h2 className="connections-section__title">Connected</h2>
                <span className="connections-section__count">{connectedIntegrations.length}</span>
              </div>
              <div className="connections-grid">
                {connectedIntegrations.map(integration => {
                  const needsReconnect = integration.status === 'needs_reconnect'
                  const awaitingApproval = integration.status === 'pending_org_approval'
                  const awaitingOrg = githubInstallConfig(integration.connector).awaitingOrgLogin
                  // Read off the real installation by the backend, never from
                  // what the install picker suggested: GitHub lets the user
                  // switch accounts on its own screen.
                  const subtitle = awaitingApproval ? undefined : connectedAccountLabel(integration.connector)
                  // A provider's API has moved under a connection that still
                  // works. Said on the card, because a person has no reason to
                  // open a connection that looks healthy, and said as a status
                  // rather than a sentence, like every other thing this card
                  // reports about itself.
                  const needsUpdate = !needsReconnect
                    && (integration.connector?.config as { specDrifted?: boolean } | undefined)?.specDrifted === true
                  const repositoryScope = repositoryScopeLabel(integration.connector)
                  return (
                    <div
                      key={integration.id}
                      className={`connection-card ${
                        awaitingApproval
                          ? 'connection-card--pending'
                          : needsReconnect
                            ? 'connection-card--needs-reconnect'
                            : 'connection-card--connected'
                      }`}
                    >
                      <div className="connection-card__icon">{integration.icon}</div>
                      <div className="connection-card__content">
                        <h3 className="connection-card__name">{integration.name}</h3>
                        {subtitle && <span className="connection-card__type">{subtitle}</span>}
                        {!awaitingApproval && repositoryScope && (
                          <span className="connection-card__detail">{repositoryScope}</span>
                        )}
                      </div>
                      <div className="connection-card__status">
                        {awaitingApproval ? (
                          <>
                            <StatusDot variant="warning" />
                            Waiting for approval
                          </>
                        ) : needsReconnect ? (
                          <>
                            <StatusDot variant="warning" />
                            Needs Reconnect
                          </>
                        ) : needsUpdate ? (
                          <>
                            <StatusDot variant="warning" />
                            Needs Update
                          </>
                        ) : (
                          <>
                            <StatusDot variant="connected" />
                            Connected
                          </>
                        )}
                      </div>
                      <PermissionGate permission="manage_connections" fallback={null}>
                        <button
                          className="connection-card__action"
                          onClick={() => {
                            const connectorLabel = integration.connectorType ?? integration.name
                            if (needsReconnect) {
                              track('connection_reconnect_clicked', { connector: connectorLabel })
                            } else {
                              track('connection_manage_modal_opened', { connector: connectorLabel })
                            }
                            setModal({
                              // A connection with its own manage modal goes there
                              // in BOTH states. Its cheapest repairs — check the
                              // key again, correct a host, read the endpoint
                              // again — need no new key, and sending a broken one
                              // to the connect flow hides them exactly when they
                              // are wanted. It also hides Disconnect, which is
                              // the only way to be rid of a connection that
                              // cannot be repaired: an imported MCP server
                              // pointing at a placeholder address sat on the
                              // Connections page with nothing but a Reconnect
                              // button, and no way to remove it.
                              type: needsReconnect && !SELF_MANAGED_CONNECTOR_TYPES.has(integration.connectorType ?? '')
                                ? 'connect'
                                : 'manage',
                              integration,
                            })
                          }}
                        >
                          {needsReconnect ? 'Reconnect' : 'Manage'}
                        </button>
                      </PermissionGate>
                      {/* Full-width second row. Inside __content it would be
                          squeezed into the column left over by the status pill
                          and the button, and wrap to five cramped lines. */}
                      {awaitingApproval && (
                        <p className="connection-card__note">
                          An owner of {awaitingOrg ?? 'the organization'} needs to approve this
                          installation. This card will update automatically once they do.
                        </p>
                      )}
                    </div>
                  )
                })}
              </div>
            </section>
          )}

          {availableIntegrations.length > 0 && (
            <section className="connections-section">
              <div className="connections-section__header">
                <h2 className="connections-section__title">Available</h2>
                <span className="connections-section__count">{availableIntegrations.length}</span>
              </div>
              <div className="connections-grid">
                {availableIntegrations.map(integration => (
                  <div key={integration.id} className="connection-card connection-card--available">
                    <div className="connection-card__icon">{integration.icon}</div>
                    <div className="connection-card__content">
                      <h3 className="connection-card__name">{integration.name}</h3>
                      <span className="connection-card__type">{integration.type}</span>
                    </div>
                    <PermissionGate permission="manage_connections" fallback={null}>
                      <button
                        className="connection-card__connect"
                        onClick={() => setModal({ type: 'connect', integration })}
                        disabled={!integration.connectorType || !supportsConnection(integration.connectorType)}
                      >
                        <PlusIcon width="14" height="14" />
                        Connect
                      </button>
                    </PermissionGate>
                  </div>
                ))}
              </div>
            </section>
          )}

          {plannedIntegrations.length > 0 && (
            <section className="connections-section">
              <div className="connections-section__header">
                <h2 className="connections-section__title">Coming Soon</h2>
                <span className="connections-section__count">{plannedIntegrations.length}</span>
              </div>
              <div className="connections-grid">
                {plannedIntegrations.map(integration => (
                  <div key={integration.id} className="connection-card connection-card--planned">
                    <div className="connection-card__icon">{integration.icon}</div>
                    <div className="connection-card__content">
                      <h3 className="connection-card__name">{integration.name}</h3>
                      <span className="connection-card__type">{integration.type}</span>
                    </div>
                    <span className="connection-card__coming-soon">Coming Soon</span>
                  </div>
                ))}
              </div>
            </section>
          )}
          </div>
        )}
      </div>

      {/* Connect Modal — handles both OAuth and API key flows internally. For a
          reconnect (the integration carries a live connector), it also offers a
          Disconnect action wired to the same handler as the manage modal. */}
      {modal?.type === 'connect' && (
        <ConnectIntegrationModal
          integration={modal.integration}
          onClose={() => setModal(null)}
          onDisconnect={handleDisconnect}
          disconnecting={isDisconnecting}
        />
      )}

      {/* Manage Modal */}
      {modal?.type === 'manage' && modal.integration.connectorType === 'custom_mcp_server' && modal.integration.connector && (
        <ManageCustomMcpServerModal
          connectorId={modal.integration.connector.id}
          displayName={modal.integration.name}
          icon={modal.integration.icon}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'manage' && modal.integration.connectorType === 'custom_api_connector' && modal.integration.connector && (
        <ManageCustomApiConnectionModal
          connectorId={modal.integration.connector.id}
          displayName={modal.integration.name}
          icon={modal.integration.icon}
          onClose={() => setModal(null)}
        />
      )}
      {modal?.type === 'manage'
        && modal.integration.connectorType !== 'custom_mcp_server'
        && modal.integration.connectorType !== 'custom_api_connector' && (
        <ModalOverlay onClose={() => setModal(null)} disableClose={isDisconnecting}>
          <div className="connection-modal__icon">{modal.integration.icon}</div>
          <h2 className="connection-modal__title">{modal.integration.name}</h2>
          {modal.integration.status === 'pending_org_approval' ? (
            <>
              <div className="connection-modal__status-row">
                <StatusDot variant="warning" size="md" />
                <span>Waiting for approval</span>
              </div>
              <p className="connection-modal__description">
                An owner of{' '}
                {githubInstallConfig(modal.integration.connector).awaitingOrgLogin ?? 'the organization'}
                {' '}needs to approve this installation. Removing this connection will not withdraw
                the request in GitHub.
              </p>
            </>
          ) : (
            <div className="connection-modal__status-row">
              <StatusDot variant="connected" size="md" />
              <span>Connected</span>
            </div>
          )}
          {/* Disconnect deletes our connector row. With a GitHub App installed
              that does NOT uninstall anything: Liftoff keeps its write access on
              the account until someone removes the installation in GitHub. A
              user who disconnects believing they revoked access would be wrong,
              so say so and give them the place to do it. */}
          {hasGitHubApp(modal.integration.connector) && (
            <div className="connection-modal__objects">
              <span className="connection-modal__objects-label">Before you disconnect</span>
              <p className="connection-modal__objects-list">
                Disconnecting removes this connection from Liftoff. The Liftoff app stays installed
                in GitHub, with the access you granted it, until you remove it there.
              </p>
              <p className="connection-modal__help-link">
                <a href="https://github.com/settings/installations" target="_blank" rel="noopener noreferrer">
                  Manage the installation on GitHub
                </a>
              </p>
            </div>
          )}
          {modal.integration.connector?.lastSyncAt && (
            <p className="connection-modal__sync-info">
              Last synced: {new Date(modal.integration.connector.lastSyncAt).toLocaleString()}
            </p>
          )}
          {modal.integration.connector?.apiKeyHint && (
            <div className="connection-modal__credential-hint">
              <span className="connection-modal__credential-hint-label">API Key</span>
              <span className="connection-modal__credential-hint-value">{modal.integration.connector.apiKeyHint}</span>
            </div>
          )}
          {modal.integration.objectsCovered.length > 0 && (
            <div className="connection-modal__objects">
              <span className="connection-modal__objects-label">Syncing:</span>
              <div className="connection-modal__objects-grid">
                {modal.integration.objectsCovered.map(obj => (
                  <span key={obj} className="connection-modal__object-tag">{obj}</span>
                ))}
              </div>
            </div>
          )}
          <div className="connection-modal__actions">
            <Button
              variant="outline"
              onClick={handleDisconnect}
              disabled={isDisconnecting}
              loading={isDisconnecting}
            >
              Disconnect
            </Button>
            <Button variant="primary" onClick={() => setModal(null)} disabled={isDisconnecting}>
              Done
            </Button>
          </div>
        </ModalOverlay>
      )}
    </>
  )
}
