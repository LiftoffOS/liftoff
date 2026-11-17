// ConnectCustomMcpServerModal — single-form modal for registering a
// tenant-owned MCP server.
//
// Endpoint + tunnel toggle + auth picker + auth-specific fields are
// rendered by the shared <McpEndpointFields /> so this modal stays in
// lockstep with /dashboard/agents/connect's IdentifyAgentStep (same auth
// types, same custom-headers UX, same TunnelSetup integration).

import { useState } from 'react'
import Button from './Button'
import TextInput from './TextInput/TextInput'
import ModalOverlay from './ModalOverlay'
import McpEndpointFields, {
  type McpEndpointFieldsValue,
  type McpAuthType,
  type McpCustomHeader,
} from './McpEndpointFields'
import { useCreateCustomMcpServer } from '../hooks/useCustomMcpServers'
import type { AuthType, CustomHeader } from '../services/customMcpServers'
import type { Integration } from '../hooks/useIntegrations'
import { useToast } from '../contexts/ToastContext'

interface ConnectCustomMcpServerModalProps {
  integration: Integration
  onClose: () => void
  onSuccess?: () => void
}

export default function ConnectCustomMcpServerModal({
  integration,
  onClose,
  onSuccess,
}: ConnectCustomMcpServerModalProps) {
  const createServer = useCreateCustomMcpServer()
  const { showToast } = useToast()
  const [name, setName] = useState('')
  const [endpoint, setEndpoint] = useState<McpEndpointFieldsValue>({
    endpointUrl: '',
    authType: 'none',
    apiKey: '',
    bearerToken: '',
    customHeaders: [],
    tunnelRouteId: null,
  })

  const submitting = createServer.isPending
  const canSubmit =
    name.trim().length > 0 && endpoint.endpointUrl.trim().length > 0 && !submitting

  const handleClose = () => {
    if (!submitting) onClose()
  }

  const handleSubmit = async () => {
    if (!canSubmit) return
    const trimmedName = name.trim()
    try {
      await createServer.mutateAsync({
        name: trimmedName,
        deliveryMode: endpoint.tunnelRouteId ? 'tunneled' : 'public_url',
        endpointUrl: endpoint.endpointUrl.trim(),
        authType: endpoint.authType as AuthType,
        apiKey: endpoint.authType === 'api_key' ? endpoint.apiKey : undefined,
        bearerToken: endpoint.authType === 'bearer_token' ? endpoint.bearerToken : undefined,
        customHeaders:
          endpoint.authType === 'custom_headers'
            ? (endpoint.customHeaders as CustomHeader[])
            : undefined,
        tunnelRouteId: endpoint.tunnelRouteId ?? undefined,
      })
      showToast(`${trimmedName} connected`, 'success')
      onSuccess?.()
      onClose()
    } catch (err) {
      // Surface backend errors (PERMISSION_DENIED, validation, discovery
      // failures, etc.) instead of silently swallowing — matches the
      // instant-connect handler in ConnectionsPage.
      const message = err instanceof Error ? err.message : 'Unknown error'
      showToast(`Failed to connect ${trimmedName}: ${message}`, 'error')
    }
  }

  return (
    <ModalOverlay onClose={handleClose} disableClose={submitting}>
      <div className="connection-modal__icon">{integration.icon}</div>
      <h2 className="connection-modal__title">Connect {integration.name}</h2>
      <p className="connection-modal__description">
        Give your agents access to a custom tool server. Register an MCP
        server hosted at a public URL, or run it inside your network and expose
        it through a Liftoff tunnel.
      </p>

      <div className="connection-modal__fields">
        <TextInput
          id="custom-mcp-name"
          label="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
          placeholder="Internal analytics tools"
          autoComplete="off"
          disabled={submitting}
        />

        <McpEndpointFields
          value={endpoint}
          onChange={setEndpoint}
          entityKind="mcp_server"
          entityName={name}
          disabled={submitting}
        />
      </div>

      <div className="connection-modal__actions">
        <Button variant="outline" onClick={handleClose} disabled={submitting}>
          Cancel
        </Button>
        <Button
          variant="primary"
          onClick={() => void handleSubmit()}
          disabled={!canSubmit}
          loading={submitting}
        >
          {submitting ? 'Adding…' : 'Add'}
        </Button>
      </div>
    </ModalOverlay>
  )
}

// Re-export the shared types so external callers (e.g. tests, storybook,
// stale imports from the old modal shape) don't break.
export type { McpAuthType, McpCustomHeader }
