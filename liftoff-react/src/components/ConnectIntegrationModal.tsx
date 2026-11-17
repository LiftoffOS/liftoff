import { useState } from 'react'
import { useNavigate } from 'react-router'
import Button from './Button'
import TextInput from './TextInput/TextInput'
import ModalOverlay from './ModalOverlay'
import ConnectApiKeyModal from './ConnectApiKeyModal'
import ConnectKeypairModal from './ConnectKeypairModal'
import ConnectIamGrantModal from './ConnectIamGrantModal'
import ConnectCustomMcpServerModal from './ConnectCustomMcpServerModal'
import { useIntegrationConnect } from '../hooks/useIntegrationConnect'
import { useConnectorCatalog } from '../hooks/useConnectorCatalog'
import type { Integration } from '../hooks/useIntegrations'
import { useAutoFocus } from '../hooks/useAutoFocus'

const SUBDOMAIN_CONNECTORS: Record<string, { label: string; placeholder: string; suffix: string }> = {
  zendesk: {
    label: 'Zendesk Subdomain',
    placeholder: 'yourcompany',
    suffix: '.zendesk.com',
  },
  // BambooHR OAuth is per-company-subdomain: the authorize/token URLs are
  // https://{subdomain}.bamboohr.com/... so the connect flow collects it first.
  bamboohr: {
    label: 'BambooHR Subdomain',
    placeholder: 'yourcompany',
    suffix: '.bamboohr.com',
  },
}

interface ConnectIntegrationModalProps {
  integration: Integration
  onClose: () => void
  onSuccess?: () => void
  /**
   * Caller-owned disconnect handler. When provided AND the integration has a
   * live connector (the reconnect scenario — a `needs_reconnect` tile), a grey
   * "Disconnect" action is shown between Cancel and the primary CTA so the user
   * can remove a broken connection instead of only being able to reconnect.
   * Fresh "Available" connects carry no `connector`, so nothing renders there.
   * Opt-in so the AgentBuilder/TeamUpdate and Knowledge connect flows (which
   * don't pass it) are unaffected.
   */
  onDisconnect?: () => void
  /** Loading state for the Disconnect button (owned by the caller). */
  disconnecting?: boolean
  /**
   * Overrides the default "give your agents access to this app" description,
   * for callers where connecting does something other than granting agent tools.
   */
  description?: string
  /** Hide the "Available data" row, for callers where it does not apply. */
  hideAvailableData?: boolean
  /** Suppress the built-in success toast — the caller shows its own after a
   * follow-up step (bind + sync). */
  suppressSuccessToast?: boolean
}

export default function ConnectIntegrationModal({
  integration,
  onClose,
  onSuccess,
  onDisconnect,
  disconnecting = false,
  description,
  hideAvailableData = false,
  suppressSuccessToast = false,
}: ConnectIntegrationModalProps) {
  const subdomainRef = useAutoFocus<HTMLInputElement>()
  const { connect, connecting, cancelConnect, canConnect, installTargetModal } = useIntegrationConnect({
    onSuccess,
    suppressSuccessToast,
  })
  const { usesApiKey, usesKeypair, usesCustomMcp, usesCustomApi, usesIamGrant } = useConnectorCatalog()
  const navigate = useNavigate()
  // Reconnect scenario: an existing (broken) connector plus a caller-provided
  // disconnect handler. This is the only case with three footer buttons
  // (Cancel / Disconnect / Connect), so its CTA drops the connector name — just
  // "Connect" — to keep the row from exceeding the modal width for long names.
  const isReconnect = Boolean(onDisconnect && integration.connector?.id)
  const baseDescription =
    description ?? `Connect your ${integration.name} account to give your agents access to this app.`
  const [showApiKeyModal, setShowApiKeyModal] = useState(false)
  const [showKeypairModal, setShowKeypairModal] = useState(false)
  const [showIamGrantModal, setShowIamGrantModal] = useState(false)
  const [subdomainValue, setSubdomainValue] = useState('')
  const [showSubdomainStep, setShowSubdomainStep] = useState(false)

  const handleConnect = async () => {
    if (integration.connectorType && usesKeypair(integration.connectorType)) {
      setShowKeypairModal(true)
      return
    }
    // Keyless IAM-grant connectors (e.g. BigQuery): transition to the
    // provision → grant → verify modal.
    if (integration.connectorType && usesIamGrant(integration.connectorType)) {
      setShowIamGrantModal(true)
      return
    }
    // If this is an API-key connector, transition to the API key modal
    if (integration.connectorType && usesApiKey(integration.connectorType)) {
      setShowApiKeyModal(true)
      return
    }
    // Subdomain pre-auth step
    if (integration.connectorType && SUBDOMAIN_CONNECTORS[integration.connectorType] && !showSubdomainStep) {
      setShowSubdomainStep(true)
      return
    }

    let dynamicUrlParams: Record<string, string> | undefined
    if (integration.connectorType && SUBDOMAIN_CONNECTORS[integration.connectorType]) {
      dynamicUrlParams = { subdomain: subdomainValue.trim() }
    }

    // Otherwise, start OAuth flow. integration.connector?.id is set only for
    // Connected/needs_reconnect cards → reconnect targets that exact row.
    const success = await connect(integration.connectorType, integration.name, dynamicUrlParams, integration.connector?.id)
    if (success) {
      onClose()
    }
  }

  const handleClose = () => {
    if (connecting) {
      cancelConnect()
    }
    onClose()
  }

  // GitHub's second leg. connect() is still awaiting this, so replacing the
  // modal rather than stacking one on top keeps a single dialog on screen.
  if (installTargetModal) {
    return installTargetModal
  }

  if (showKeypairModal) {
    return (
      <ConnectKeypairModal
        integration={integration}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    )
  }

  if (showIamGrantModal) {
    return (
      <ConnectIamGrantModal
        integration={integration}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    )
  }

  // Custom API: the tile STARTS A CONVERSATION, it does not open a form.
  //
  // There is no static form behind this type — the hosts, the placement, the
  // verification call and the operations only exist once an assistant has read
  // a particular provider's documentation — so a Connect modal here would be a
  // dead end. Keeping the tile out of the grid entirely was the alternative and
  // was rejected: the Connections page is where someone goes when they want an
  // app we do not have, so leaving it out makes the whole capability invisible
  // to anyone who has not been told about it.
  if (integration.connectorType && usesCustomApi(integration.connectorType)) {
    return (
      <ModalOverlay onClose={handleClose}>
        <div className="connection-modal__icon">{integration.icon}</div>
        <h2 className="connection-modal__title">Custom API</h2>
        <p className="connection-modal__description">
          Tell Liftoff which service you want to connect. Liftoff will help you establish
          the connection.
        </p>
        <div className="connection-modal__actions">
          <Button variant="outline" onClick={handleClose}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => {
              onClose()
              navigate('/dashboard/liftoff', {
                state: {
                  seedMessage:
                    'I want to connect an API that is not in the Connections page yet. '
                    + 'Can you help me set it up?',
                },
              })
            }}
          >
            Continue
          </Button>
        </div>
      </ModalOverlay>
    )
  }

  // Custom MCP Server uses its own single-form modal with an inline
  // <TunnelSetup /> branch. Always renders if the connector catalog marks
  // this connector's auth.kind === 'custom_mcp'.
  if (integration.connectorType && usesCustomMcp(integration.connectorType)) {
    return (
      <ConnectCustomMcpServerModal
        integration={integration}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    )
  }

  // Render the API key modal instead when user has committed to connecting
  if (showApiKeyModal) {
    return (
      <ConnectApiKeyModal
        integration={integration}
        onClose={onClose}
        onSuccess={onSuccess}
      />
    )
  }

  return (
    <ModalOverlay onClose={handleClose} disableClose={disconnecting}>
      <div className="connection-modal__icon">{integration.icon}</div>
      <h2 className="connection-modal__title">Connect {integration.name}</h2>
      {showSubdomainStep && integration.connectorType ? (
        <>
          <p className="connection-modal__description">
            {baseDescription} Enter your subdomain to continue.
          </p>
          <div className="connection-modal__fields">
            <TextInput
              id="subdomain-input"
              label={SUBDOMAIN_CONNECTORS[integration.connectorType].label}
              placeholder={SUBDOMAIN_CONNECTORS[integration.connectorType].placeholder}
              suffix={SUBDOMAIN_CONNECTORS[integration.connectorType].suffix}
              value={subdomainValue}
              onChange={e => setSubdomainValue(e.target.value)}
              onKeyDown={e => { if (e.key === 'Enter' && subdomainValue.trim()) handleConnect() }}
              ref={subdomainRef}
            />
          </div>
          <div className="connection-modal__actions">
            <Button variant="outline" onClick={handleClose} disabled={disconnecting}>Cancel</Button>
            {isReconnect && (
              <Button
                variant="outline"
                onClick={onDisconnect}
                disabled={connecting || disconnecting}
                loading={disconnecting}
              >
                Disconnect
              </Button>
            )}
            <Button
              variant="primary"
              onClick={handleConnect}
              disabled={connecting || disconnecting || !subdomainValue.trim()}
            >
              {connecting ? 'Connecting...' : 'Continue'}
            </Button>
          </div>
        </>
      ) : (
        <>
          <p className="connection-modal__description">
            {baseDescription}
          </p>
          {!hideAvailableData && integration.objectsCovered.length > 0 && (
            <div className="connection-modal__objects">
              <span className="connection-modal__objects-label">Available data:</span>
              <span className="connection-modal__objects-list">
                {integration.objectsCovered.join(', ')}
              </span>
            </div>
          )}
          <div className="connection-modal__actions">
            <Button variant="outline" onClick={handleClose} disabled={disconnecting}>Cancel</Button>
            {isReconnect && (
              <Button
                variant="outline"
                onClick={onDisconnect}
                disabled={connecting || disconnecting}
                loading={disconnecting}
              >
                Disconnect
              </Button>
            )}
            <Button
              variant="primary"
              onClick={handleConnect}
              disabled={connecting || disconnecting || !canConnect(integration.connectorType)}
            >
              {connecting ? 'Connecting...' : isReconnect ? 'Connect' : `Connect ${integration.name}`}
            </Button>
          </div>
        </>
      )}
    </ModalOverlay>
  )
}
