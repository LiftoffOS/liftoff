// ManageCustomMcpServerModal — detail/manage modal for a registered
// Custom MCP Server tile. Mirrors the existing connections manage modal
// (ConnectionsPage.tsx) — same icon header, status row, .connection-modal__*
// section structure, Button + disconnect-styled action — with two extra
// sections for the per-server endpoint config and the discovered tools list.

import { useMemo, useState } from 'react'
import Button from './Button'
import { Dropdown, type DropdownOption } from './Dropdown'
import ModalOverlay from './ModalOverlay'
import StatusDot from './StatusDot'
import TextInput from './TextInput/TextInput'
import {
  useCustomMcpServer,
  useCustomMcpServers,
  useDeleteCustomMcpServer,
  useRediscoverCustomMcpServer,
  useUpdateCustomMcpServer,
} from '../hooks/useCustomMcpServers'
import { useConnectors, useDeleteConnector } from '../hooks/useConnectors'
import type { AuthType } from '../services/customMcpServers'
import { useTunnelRoutes } from '../hooks/useTunnels'
import { useToast } from '../contexts/ToastContext'

interface ManageCustomMcpServerModalProps {
  /**
   * Either the custom_mcp_servers.id directly OR the connector instance id
   * (which we resolve to a server id by matching connectorId). Connections
   * tiles surface connector ids, so the connectorId path is the common one.
   */
  serverId?: string
  connectorId?: string
  displayName: string
  icon?: React.ReactNode
  onClose: () => void
}

const AUTH_LABELS: Record<string, string> = {
  none: 'None',
  api_key: 'API key',
  bearer_token: 'Bearer token',
  custom_headers: 'Custom headers',
}

// Same options, same order as the connect flow (McpEndpointFields) — this modal
// edits what that form created, so the control has to be the same control.
const AUTH_OPTIONS: DropdownOption[] = Object.entries(AUTH_LABELS).map(
  ([value, label]) => ({ value, label }),
)

export default function ManageCustomMcpServerModal({
  serverId,
  connectorId,
  displayName,
  icon,
  onClose,
}: ManageCustomMcpServerModalProps) {
  const { data: allServers = [], isPending: serversPending } = useCustomMcpServers()
  const resolvedId = useMemo(() => {
    if (serverId) return serverId
    if (connectorId) return allServers.find((s) => s.connectorId === connectorId)?.id
    return undefined
  }, [serverId, connectorId, allServers])
  // Orphan tile: a connector-service row exists with type='custom_mcp_server'
  // but no paired row in platform-backend's custom_mcp_servers. Happens when
  // a create call failed mid-flight and the compensating soft-delete didn't
  // run or also failed. Without a paired row, the standard delete endpoint
  // can't find anything, so we fall back to deleting the connector-service
  // row directly — that's enough to remove the tile from the UI.
  const isOrphan = !serverId && !!connectorId && !serversPending && !resolvedId
  const { data: server, isLoading } = useCustomMcpServer(resolvedId)
  // For tunneled servers, the meaningful URL is the customer's internal
  // upstream (e.g. http://analytics.internal:7000), not the tunnel
  // terminator URL we synthesize on tunnels.example.com. Fetch the
  // route to surface that. Cheap: tunnel routes are tenant-scoped and
  // already cached by useTunnelRoutes elsewhere on the page.
  const { data: tunnelRoutes = [] } = useTunnelRoutes()
  const tunnelRoute = server?.tunnelRouteId
    ? tunnelRoutes.find((r) => r.id === server.tunnelRouteId)
    : undefined
  const rediscover = useRediscoverCustomMcpServer()
  const remove = useDeleteCustomMcpServer()
  const removeConnector = useDeleteConnector()
  const update = useUpdateCustomMcpServer()
  const { showToast } = useToast()

  // The connector row carries the health the probe writes. A server that stops
  // answering is flagged there, and this modal is where it gets fixed, so the
  // state has to be visible in the place that repairs it.
  const { data: connectors = [] } = useConnectors()
  const connectorRow = useMemo(
    () => connectors.find((c) => c.id === (connectorId ?? server?.connectorId)),
    [connectors, connectorId, server?.connectorId],
  )
  const isUnreachable = connectorRow?.status === 'error'

  // Editing is opt-in. The modal opens read-only so a glance at the config
  // cannot become an accidental edit, and the fields only appear once someone
  // has said they intend to change something.
  const [editing, setEditing] = useState(false)
  const [endpointDraft, setEndpointDraft] = useState('')
  const [authTypeDraft, setAuthTypeDraft] = useState<AuthType>('none')
  const [secretDraft, setSecretDraft] = useState('')

  // Seeded during render, so opening the modal does not paint empty fields on
  // the first frame and the server's values on the second.
  // Starts as undefined, NOT as `server`. Seeding from the current value
  // would make the comparison false on the very first render, so a modal
  // opened with its server already loaded would show empty fields forever.
  const [seededServer, setSeededServer] = useState<typeof server | undefined>(undefined)
  if (server && server !== seededServer) {
    setSeededServer(server)
    setEndpointDraft(server.endpointUrl)
    setAuthTypeDraft(server.authType)
    setSecretDraft('')
  }

  const submitting =
    rediscover.isPending || remove.isPending || removeConnector.isPending || update.isPending

  // The stored credential cannot be read back, so an unchanged auth type with
  // an empty box means "keep it". Changing the type is the one case that must
  // carry a value, because there is nothing stored for the new type yet.
  const needsSecretForNewType =
    authTypeDraft !== server?.authType
    && authTypeDraft !== 'none'
    && authTypeDraft !== 'custom_headers'
    && !secretDraft.trim()

  const isTunneled = server?.deliveryMode === 'tunneled'
  const endpointChanged = !isTunneled && !!server && endpointDraft.trim() !== server.endpointUrl
  const authChanged = !!server && (authTypeDraft !== server.authType || !!secretDraft.trim())
  const hasChanges = endpointChanged || authChanged

  const handleSave = async () => {
    if (!resolvedId || !hasChanges || needsSecretForNewType) return
    try {
      await update.mutateAsync({
        id: resolvedId,
        data: {
          ...(endpointChanged ? { endpointUrl: endpointDraft.trim() } : {}),
          ...(authTypeDraft !== server?.authType ? { authType: authTypeDraft } : {}),
          ...(secretDraft.trim() && authTypeDraft === 'api_key' ? { apiKey: secretDraft.trim() } : {}),
          ...(secretDraft.trim() && authTypeDraft === 'bearer_token'
            ? { bearerToken: secretDraft.trim() }
            : {}),
        },
      })
      setEditing(false)
      setSecretDraft('')
      showToast(`Updated ${displayName}`, 'success')
    } catch (err) {
      console.error('Failed to update MCP server:', err)
      showToast('Failed to save changes. Please try again.', 'error')
    }
  }

  const handleRediscover = async () => {
    if (!resolvedId) return
    await rediscover.mutateAsync(resolvedId).catch((err) => {
      console.error('rediscover failed', err)
    })
  }

  const handleDisconnect = async () => {
    if (!resolvedId && !isOrphan) return
    const ok = confirm(
      `Disconnect "${displayName}"? agents bound to it will lose access to its tools.`,
    )
    if (!ok) return
    try {
      if (resolvedId) {
        await remove.mutateAsync(resolvedId)
      } else if (connectorId) {
        await removeConnector.mutateAsync(connectorId)
      }
      onClose()
      showToast(`Disconnected ${displayName}`, 'success')
    } catch (err) {
      console.error('Failed to disconnect:', err)
      showToast('Failed to disconnect. Please try again.', 'error')
    }
  }

  const handleClose = () => {
    if (!submitting) onClose()
  }

  const tools = (server?.rawMcpTools ?? []) as Array<{ name: string; description?: string }>

  // --fit: this footer runs to four buttons either way (Disconnect /
  // Rediscover Tools / Edit / Done, and Cancel / Save in their place while
  // editing), which is wider than a 400px modal. The row is not allowed to
  // wrap, so the box grows to the row instead.
  return (
    <ModalOverlay
      onClose={handleClose}
      disableClose={submitting}
      contentClassName="modal-overlay__content--fit"
    >
      {icon && <div className="connection-modal__icon">{icon}</div>}
      <h2 className="connection-modal__title">{displayName}</h2>
      <div className="connection-modal__status-row">
        <StatusDot variant={isUnreachable ? 'error' : 'connected'} size="md" />
        <span>{isUnreachable ? 'Not responding' : 'Connected'}</span>
      </div>
      {isUnreachable && (
        <p className="connection-modal__loading">
          This server did not answer the last checks. Update the endpoint or the
          credentials below, or check that the server is running.
        </p>
      )}

      {isOrphan ? (
        // Orphan: no paired custom_mcp_servers row, so there's nothing to
        // load. Surface this clearly and let the user disconnect the entry.
        <p className="connection-modal__loading">
          This entry is in an inconsistent state and can only be disconnected.
        </p>
      ) : isLoading || !server || serversPending ? (
        <div className="connection-modal__spinner">
          <div className="loading-spinner" role="status" aria-label="Loading server details" />
        </div>
      ) : (
        <>
          {server.deliveryMode === 'tunneled' ? (
            // Tunneled: show the customer's internal upstream URL — that's
            // the meaningful identifier for their own service. The
            // tunnels.example.com endpoint we'd otherwise show is Liftoff
            // infrastructure detail. Not editable here: the tunnel route owns
            // this address, and changing it is a change to the route.
            <div className="connection-modal__credential-hint">
              <span className="connection-modal__credential-hint-label">Internal URL</span>
              <span className="connection-modal__credential-hint-value">
                {tunnelRoute?.upstreamUrl ?? '—'}
              </span>
            </div>
          ) : editing ? (
            <label className="connection-modal__credential-hint">
              <span className="connection-modal__credential-hint-label">Endpoint URL</span>
              <TextInput
                value={endpointDraft}
                onChange={(e) => setEndpointDraft(e.target.value)}
                placeholder="https://mcp.example.com/sse"
                disabled={submitting}
              />
            </label>
          ) : (
            // Publicly reachable: show the URL the customer pasted.
            <div className="connection-modal__credential-hint">
              <span className="connection-modal__credential-hint-label">Endpoint URL</span>
              <span className="connection-modal__credential-hint-value">{server.endpointUrl}</span>
            </div>
          )}
          {editing ? (
            <>
              {/* A div, not a label: Dropdown is a button + listbox, not a
                  native form control, so there is nothing for a label to bind
                  to and wrapping one would just re-toggle the trigger. */}
              <div className="connection-modal__credential-hint">
                <span className="connection-modal__credential-hint-label">Authentication</span>
                <Dropdown
                  options={AUTH_OPTIONS}
                  value={authTypeDraft}
                  onChange={(v) => setAuthTypeDraft(v as AuthType)}
                  disabled={submitting}
                />
              </div>
              {(authTypeDraft === 'api_key' || authTypeDraft === 'bearer_token') && (
                <label className="connection-modal__credential-hint">
                  <span className="connection-modal__credential-hint-label">
                    {authTypeDraft === 'api_key' ? 'API key' : 'Bearer token'}
                  </span>
                  <TextInput
                    type="password"
                    value={secretDraft}
                    onChange={(e) => setSecretDraft(e.target.value)}
                    placeholder={
                      authTypeDraft === server.authType
                        ? 'Leave blank to keep the saved value'
                        : 'Required for this authentication type'
                    }
                    disabled={submitting}
                  />
                </label>
              )}
              {authTypeDraft === 'custom_headers' && authTypeDraft !== server.authType && (
                <p className="connection-modal__loading">
                  Custom headers are set when the server is added. Remove and add
                  the server again to change them.
                </p>
              )}
            </>
          ) : (
            <div className="connection-modal__credential-hint">
              <span className="connection-modal__credential-hint-label">Authentication</span>
              <span className="connection-modal__credential-hint-value">
                {AUTH_LABELS[server.authType] ?? server.authType}
              </span>
            </div>
          )}
          {tools.length > 0 && (
            <div className="connection-modal__objects">
              <span className="connection-modal__objects-label">
                Tools ({tools.length})
              </span>
              <div className="connection-modal__objects-grid">
                {tools.map((tool) => (
                  <span key={tool.name} className="connection-modal__object-tag">
                    {tool.name}
                  </span>
                ))}
              </div>
            </div>
          )}
        </>
      )}

      <div className="connection-modal__actions">
        <Button
          variant="outline"
          onClick={() => void handleDisconnect()}
          disabled={submitting || serversPending || (isLoading && !isOrphan)}
          loading={remove.isPending || removeConnector.isPending}
        >
          Disconnect
        </Button>
        <Button
          variant="outline"
          onClick={() => void handleRediscover()}
          disabled={submitting || isLoading || isOrphan || editing}
          loading={rediscover.isPending}
        >
          {rediscover.isPending ? 'Rediscovering…' : 'Rediscover Tools'}
        </Button>
        {editing ? (
          <>
            <Button variant="outline" onClick={() => setEditing(false)} disabled={submitting}>
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={() => void handleSave()}
              disabled={submitting || !hasChanges || needsSecretForNewType}
              loading={update.isPending}
            >
              Save
            </Button>
          </>
        ) : (
          <>
            <Button
              variant="outline"
              onClick={() => setEditing(true)}
              disabled={submitting || isLoading || isOrphan || !server}
            >
              Edit
            </Button>
            <Button variant="primary" onClick={handleClose} disabled={submitting}>
              Done
            </Button>
          </>
        )}
      </div>
    </ModalOverlay>
  )
}
