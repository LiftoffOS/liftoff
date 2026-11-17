// ManageCustomApiConnectionModal — the detail and repair surface for a custom
// API connection tile.
//
// Mirrors ManageCustomMcpServerModal: same icon header, status row and
// `.connection-modal__*` sections, and the same read-only-until-you-say-so
// editing, because both are per-instance connectors whose detail lives outside
// the connector row.
//
// FOUR SEPARATE CONTROLS, AND NONE OF THEM IMPLIES ANOTHER. That is what this
// modal exists to make true rather than merely say:
//
//   Check Again   re-runs the provider's own verification with the key already
//                 in custody. A connection that broke on a rate limit, or on an
//                 endpoint that was briefly gone, comes back with nobody asked
//                 for anything.
//   Edit          hosts, base address, placement and the verification call, in
//                 place. The connector id is kept, so every bound agent keeps
//                 working and no tool is renamed. The key is not touched.
//   Remove key    discards OUR copy. The connection, its operations and every
//                 binding survive; it goes to Needs reconnect. It revokes
//                 NOTHING at the provider, and the modal says so — a person who
//                 removes our copy believing they have revoked the key has
//                 revoked nothing.
//   Disconnect    removes the connection itself, which is the page's ordinary
//                 disconnect and is a different thing again.

import { useState } from 'react'
import Button from './Button'
import ModalOverlay from './ModalOverlay'
import StatusDot from './StatusDot'
import TextInput from './TextInput/TextInput'
import { useConnectors, useDeleteConnector } from '../hooks/useConnectors'
import {
  useCustomApiConnection,
  useRefreshCustomApiSpec,
  useReverifyCustomApiConnection,
  useUpdateCustomApiConnection,
} from '../hooks/useCustomApiConnection'
import { useToast } from '../contexts/ToastContext'
import type { CustomApiConnection, CustomApiVerificationOutcome } from '../services/customApiCapture'

interface ManageCustomApiConnectionModalProps {
  connectorId: string
  displayName: string
  icon?: React.ReactNode
  onClose: () => void
}

/** Where the key goes, in the words the capture page used. */
function placementLabel(auth: CustomApiConnection['auth']): string {
  switch (auth.scheme) {
    case 'bearer_header':
      return 'Bearer token in the Authorization header'
    case 'header':
      return `${auth.name} header`
    case 'query':
      return `${auth.name} query parameter`
    case 'path':
      return `${auth.name} segment of the address`
    default:
      return auth.scheme
  }
}

/** What a failed check is, in the words a person reads.
 *
 *  Derived from the LAYER, never from the outcome's own message: that one is
 *  written for diagnosis and carries the verification address, and an address
 *  with a credential parameter in it is exactly the inner working no assistant
 *  or surface shows a person. The detail keeps its place in the logs and on
 *  the model-facing path, where somebody is actually debugging.
 *
 *  A 401 is not proof the key is wrong, so this never says it is. */
function checkFailureLine(displayName: string, outcome: CustomApiVerificationOutcome): string {
  switch (outcome.layer) {
    case 'authentication':
      return `${displayName} did not accept the key. It may belong to another environment, or lack the access this call needs.`
    case 'permission':
      return `${displayName} accepted the key but refused this call. The key does not carry the permission it needs.`
    case 'endpoint':
      return `${displayName} does not have the address this connection checks against, so the key was not tested.`
    case 'rate_limit':
      return `${displayName} is rate limiting this connection, so the key could not be tested yet.`
    default:
      return `${displayName} could not be reached.`
  }
}

export default function ManageCustomApiConnectionModal({
  connectorId,
  displayName,
  icon,
  onClose,
}: ManageCustomApiConnectionModalProps) {
  const { data: connection, isLoading } = useCustomApiConnection(connectorId)
  const { data: connectors = [] } = useConnectors()
  const connectorRow = connectors.find((c) => c.id === connectorId)
  const needsReconnect = connectorRow?.status === 'error'

  const update = useUpdateCustomApiConnection()
  const reverify = useReverifyCustomApiConnection()
  const specRefresh = useRefreshCustomApiSpec()
  const removeConnector = useDeleteConnector()
  const { showToast } = useToast()

  const [editing, setEditing] = useState(false)
  const [baseUrlDraft, setBaseUrlDraft] = useState('')
  const [hostsDraft, setHostsDraft] = useState('')
  const [verifyPathDraft, setVerifyPathDraft] = useState('')

  // Seeded during render, so opening the modal never paints empty fields on
  // the first frame and the connection's values on the second. Starts as
  // undefined rather than as `connection`: seeding from the current value
  // would make the comparison false on the very first render, and a modal
  // opened with its connection already loaded would show empty fields forever.
  const [seeded, setSeeded] = useState<CustomApiConnection | undefined>(undefined)
  if (connection && connection !== seeded) {
    setSeeded(connection)
    setBaseUrlDraft(connection.baseUrl)
    setHostsDraft(connection.apiHosts.join(', '))
    setVerifyPathDraft(connection.verification.path)
  }

  const submitting = update.isPending || reverify.isPending || specRefresh.isPending || removeConnector.isPending

  const parsedHosts = hostsDraft.split(',').map((h) => h.trim()).filter(Boolean)
  const hasChanges = !!connection && (
    baseUrlDraft.trim() !== connection.baseUrl
    || parsedHosts.join(',') !== connection.apiHosts.join(',')
    || verifyPathDraft.trim() !== connection.verification.path
  )

  const handleSave = async () => {
    if (!connection || !hasChanges) return
    try {
      const result = await update.mutateAsync({
        connectorId,
        changes: {
          ...(baseUrlDraft.trim() !== connection.baseUrl ? { baseUrl: baseUrlDraft.trim() } : {}),
          ...(parsedHosts.join(',') !== connection.apiHosts.join(',') ? { apiHosts: parsedHosts } : {}),
          ...(verifyPathDraft.trim() !== connection.verification.path
            ? {
                verification: {
                  method: connection.verification.method === 'HEAD' ? ('HEAD' as const) : ('GET' as const),
                  path: verifyPathDraft.trim(),
                  ...(connection.verification.accountIdentityField
                    ? { accountIdentityField: connection.verification.accountIdentityField }
                    : {}),
                },
              }
            : {}),
        },
      })
      setEditing(false)
      showToast(
        result.verification.ok
          ? `Updated ${displayName} and checked it against the provider`
          : `Updated ${displayName}. ${checkFailureLine(displayName, result.verification)}`,
        result.verification.ok ? 'success' : 'error',
      )
    } catch {
      showToast('Those changes were not accepted. Check the address and the hosts.', 'error')
    }
  }

  const handleReverify = async () => {
    try {
      const outcome = await reverify.mutateAsync(connectorId)
      showToast(
        outcome.ok ? `${displayName} is working` : checkFailureLine(displayName, outcome),
        outcome.ok ? 'success' : 'error',
      )
    } catch {
      showToast('The check could not be run just now. Try again in a moment.', 'error')
    }
  }


  // Two steps on purpose. Applying REPLACES the operations, so an operation
  // the provider has dropped goes, and any agent bound to it loses it. The
  // first call only looks, and what it found is what the person decides on.
  const handleSpecRefresh = async () => {
    try {
      const found = await specRefresh.mutateAsync({ connectorId })
      if (!found.changed) {
        showToast(`${displayName} is unchanged at the provider.`, 'success')
        return
      }
      const lines = [
        `${displayName} has changed at the provider.`,
        found.added.length > 0 ? `New: ${found.added.join(', ')}` : null,
        found.removed.length > 0 ? `No longer offered: ${found.removed.join(', ')}` : null,
        '',
        found.removed.length > 0
          ? 'Updating removes those from this connection, and any agent using them loses them.'
          : 'Updating gives this connection the new ones.',
      ].filter((l) => l !== null)
      if (!confirm(lines.join('\n'))) return
      const applied = await specRefresh.mutateAsync({ connectorId, apply: true })
      showToast(`${displayName} now has ${applied.operationCount} endpoints.`, 'success')
    } catch {
      showToast('The provider\u2019s specification could not be read just now. Try again in a moment.', 'error')
    }
  }

  const handleDisconnect = async () => {
    const ok = confirm(
      `Disconnect "${displayName}"? agents bound to it will lose access to its operations. `
      + 'This does not revoke the key at the provider.',
    )
    if (!ok) return
    try {
      await removeConnector.mutateAsync(connectorId)
      onClose()
      showToast(`Disconnected ${displayName}`, 'success')
    } catch {
      showToast('Failed to disconnect. Please try again.', 'error')
    }
  }

  return (
    <ModalOverlay
      onClose={() => { if (!submitting) onClose() }}
      disableClose={submitting}
      contentClassName="modal-overlay__content--fit"
    >
      {icon && <div className="connection-modal__icon">{icon}</div>}
      <h2 className="connection-modal__title">{displayName}</h2>
      <div className="connection-modal__status-row">
        <StatusDot variant={needsReconnect ? 'error' : 'connected'} size="md" />
        <span>{needsReconnect ? 'Needs reconnect' : 'Connected'}</span>
      </div>

      {needsReconnect && (
        <p className="connection-modal__loading">
          The last call to this provider did not succeed. If the key is still good, Check Again
          is enough. If it has expired or been revoked, ask Liftoff for a new connection link:
          entering a key there keeps this connection and every agent bound to it.
        </p>
      )}

      {isLoading || !connection ? (
        <div className="connection-modal__spinner">
          <div className="loading-spinner" role="status" aria-label="Loading connection details" />
        </div>
      ) : (
        <>
          {editing ? (
            <>
              <label className="connection-modal__credential-hint">
                <span className="connection-modal__credential-hint-label">Base URL</span>
                <TextInput
                  value={baseUrlDraft}
                  onChange={(e) => setBaseUrlDraft(e.target.value)}
                  placeholder="https://api.example.com"
                  disabled={submitting}
                />
              </label>
              <label className="connection-modal__credential-hint">
                <span className="connection-modal__credential-hint-label">Allowed Host</span>
                <TextInput
                  value={hostsDraft}
                  onChange={(e) => setHostsDraft(e.target.value)}
                  placeholder="api.example.com, api-eu.example.com"
                  disabled={submitting}
                />
              </label>
              <label className="connection-modal__credential-hint">
                <span className="connection-modal__credential-hint-label">
                  Verification Request ({connection.verification.method})
                </span>
                <TextInput
                  value={verifyPathDraft}
                  onChange={(e) => setVerifyPathDraft(e.target.value)}
                  placeholder="/v1/me"
                  disabled={submitting}
                />
              </label>
            </>
          ) : (
            <>
              <div className="connection-modal__credential-hint">
                <span className="connection-modal__credential-hint-label">Base URL</span>
                <span className="connection-modal__credential-hint-value">{connection.baseUrl}</span>
              </div>
              <div className="connection-modal__credential-hint">
                <span className="connection-modal__credential-hint-label">Allowed Host</span>
                <span className="connection-modal__credential-hint-value">{connection.apiHosts.join(', ')}</span>
              </div>
              <div className="connection-modal__credential-hint">
                <span className="connection-modal__credential-hint-label">Authentication</span>
                <span className="connection-modal__credential-hint-value">{placementLabel(connection.auth)}</span>
              </div>
              <div className="connection-modal__credential-hint">
                <span className="connection-modal__credential-hint-label">Verification Request</span>
                <span className="connection-modal__credential-hint-value">
                  {connection.verification.method} {connection.verification.path}
                </span>
              </div>
              <div className="connection-modal__credential-hint">
                <span className="connection-modal__credential-hint-label">Last verified</span>
                <span className="connection-modal__credential-hint-value">
                  {connection.verifiedAt
                    ? new Date(connection.verifiedAt).toLocaleString()
                    : 'Never — the provider has not accepted the key yet'}
                </span>
              </div>
            </>
          )}

          {connection.operations.length > 0 && (
            <div className="connection-modal__objects">
              <span className="connection-modal__objects-label">
                Endpoints ({connection.operations.length})
              </span>
              <div className="connection-modal__objects-grid">
                {connection.operations.map((name) => (
                  <span key={name} className="connection-modal__object-tag">{name}</span>
                ))}
              </div>
            </div>
          )}

        </>
      )}

      <div className="connection-modal__actions">
        <Button variant="outline" onClick={handleDisconnect} disabled={submitting}>
          Disconnect
        </Button>
        {editing ? (
          <>
            <Button variant="outline" onClick={() => setEditing(false)} disabled={submitting}>
              Cancel
            </Button>
            {/* Behind Edit because it CHANGES this connection: applying replaces
                the operations, so one the provider has dropped goes and any AI
                team bound to it loses it. That belongs with the other changes a
                person is deciding to make, not beside a read-only check. */}
            <Button
              variant="outline"
              onClick={handleSpecRefresh}
              disabled={submitting || !connection}
              loading={specRefresh.isPending}
            >
              Rediscover Endpoints
            </Button>
            <Button
              variant="primary"
              onClick={handleSave}
              disabled={submitting || !hasChanges || parsedHosts.length === 0}
              loading={update.isPending}
            >
              Save
            </Button>
          </>
        ) : (
          <>
            {/* Stays out here: it changes nothing, and it is the first thing
                somebody wants when a connection is not working. Putting a
                read-only check behind an edit mode would make them enter a
                mode that says they are about to change something, just to ask
                what is wrong. */}
            <Button
              variant="outline"
              onClick={handleReverify}
              disabled={submitting || !connection}
              loading={reverify.isPending}
            >
              Check Again
            </Button>
            <Button variant="outline" onClick={() => setEditing(true)} disabled={submitting || !connection}>
              Edit
            </Button>
            <Button variant="primary" onClick={onClose} disabled={submitting}>
              Done
            </Button>
          </>
        )}
      </div>
    </ModalOverlay>
  )
}
