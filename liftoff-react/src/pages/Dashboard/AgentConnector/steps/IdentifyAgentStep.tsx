import { useState } from 'react'
import { Button, Dropdown, ModalOverlay } from '../../../../components'
import TunnelSetup from '../../../../components/TunnelSetup'
import type {
  AuthType,
  DiscoverStage,
  CustomHeader,
} from '../../../../services/externalAgents'

interface Props {
  state: {
    connectionType: 'automatic' | 'custom' | null
    name: string
    endpointUrl: string
    description: string
    authType: AuthType
    apiKey: string
    bearerToken: string
    customHeaders: CustomHeader[]
    discoveryStage: DiscoverStage | null
    discoveryError: string | null
    tunnelRouteId?: string | null
  }
  updateState: (updates: Partial<Props['state']>) => void
  onCheckConnection: () => void
  isLoading: boolean
}

export default function IdentifyAgentStep({ state, updateState, onCheckConnection, isLoading }: Props) {
  const isCustom = state.connectionType === 'custom'
  const isValid = state.name.trim().length > 0 && state.endpointUrl.trim().length > 0
  const [tunnelOpen, setTunnelOpen] = useState(false)


  const handleAddHeader = () => {
    updateState({
      customHeaders: [...state.customHeaders, { key: '', value: '' }]
    })
  }

  const handleRemoveHeader = (index: number) => {
    const newHeaders = state.customHeaders.filter((_, i) => i !== index)
    updateState({ customHeaders: newHeaders })
  }

  const handleUpdateHeader = (index: number, field: 'key' | 'value', value: string) => {
    const newHeaders = state.customHeaders.map((h, i) =>
      i === index ? { ...h, [field]: value } : h
    )
    updateState({ customHeaders: newHeaders })
  }

  return (
    <div className="agent-connector-step">
      <h1 className="agent-connector-step__header">Connect External Agent</h1>

      <div className="agent-connector__field">
        <label className="agent-connector__label" htmlFor="identifyagentstep-collaborator-name">Collaborator name</label>
        <input id="identifyagentstep-collaborator-name"
          type="text"
          className="agent-connector__input"
          value={state.name}
          onChange={(e) => updateState({ name: e.target.value })}
          placeholder="E.g. Customer Success Partner"
        />
      </div>

      <div className="agent-connector__field">
        <label className="agent-connector__label" htmlFor="identifyagentstep-mcp-endpoint-url">MCP endpoint URL</label>
        <input id="identifyagentstep-mcp-endpoint-url"
          type="url"
          className="agent-connector__input"
          value={state.endpointUrl}
          onChange={(e) => updateState({ endpointUrl: e.target.value })}
          placeholder="https://agent.example.com/mcp"
        />
        <div className="agent-connector__field-action">
          <Button
            variant="outline"
            size="sm"
            onClick={() => setTunnelOpen(true)}
          >
            Use A Tunnel
          </Button>
        </div>
      </div>

      {tunnelOpen && (
        <ModalOverlay onClose={() => setTunnelOpen(false)}>
          <h2 className="connection-modal__title">Set Up A Tunnel</h2>
          <p className="connection-modal__description">
            Run a small Docker container in your network and route it to the
            private service you want to expose.
          </p>
          <TunnelSetup
            entityName={state.name || 'collaborator'}
            entityKind="agent"
            onCommit={({ tunnelRouteId, publicUrl }) => {
              updateState({ tunnelRouteId, endpointUrl: publicUrl })
              setTunnelOpen(false)
            }}
            onCancel={() => setTunnelOpen(false)}
          />
        </ModalOverlay>
      )}

      {/* Authentication options - only for custom connection */}
      {isCustom && (
        <>
          <div className="agent-connector__field">
            <label className="agent-connector__label" htmlFor="identifyagentstep-authentication">Authentication</label>
            <Dropdown id="identifyagentstep-authentication"
              value={state.authType}
              onChange={(value) => updateState({ authType: value as AuthType })}
              options={[
                { value: 'none', label: 'None' },
                { value: 'api_key', label: 'API Key' },
                { value: 'bearer_token', label: 'Bearer Token' },
                { value: 'custom_headers', label: 'Custom Headers' },
              ]}
            />
          </div>

          {state.authType === 'api_key' && (
            <div className="agent-connector__field">
              <label className="agent-connector__label" htmlFor="identifyagentstep-api-key">API Key</label>
              <input id="identifyagentstep-api-key"
                type="password"
                className="agent-connector__input"
                value={state.apiKey}
                onChange={(e) => updateState({ apiKey: e.target.value })}
                placeholder="Enter your API key"
              />
            </div>
          )}

          {state.authType === 'bearer_token' && (
            <div className="agent-connector__field">
              <label className="agent-connector__label" htmlFor="identifyagentstep-bearer-token">Bearer Token</label>
              <input id="identifyagentstep-bearer-token"
                type="password"
                className="agent-connector__input"
                value={state.bearerToken}
                onChange={(e) => updateState({ bearerToken: e.target.value })}
                placeholder="Enter your bearer token"
              />
            </div>
          )}

          {state.authType === 'custom_headers' && (
            <div className="agent-connector__field" role="group" aria-labelledby="custom-headers-label">
              <span className="agent-connector__label" id="custom-headers-label">Custom Headers</span>
              {state.customHeaders.map((header, index) => (
                <div key={index} style={{ display: 'flex', gap: '8px', marginBottom: '8px', alignItems: 'center' }}>
                  <input
                    type="text"
                    className="agent-connector__input"
                    value={header.key}
                    onChange={(e) => handleUpdateHeader(index, 'key', e.target.value)}
                    placeholder="Header name"
                    style={{ flex: 1 }}
                  />
                  <input
                    type="password"
                    className="agent-connector__input"
                    value={header.value}
                    onChange={(e) => handleUpdateHeader(index, 'value', e.target.value)}
                    placeholder="Header value"
                    style={{ flex: 1 }}
                  />
                  <button
                    type="button"
                    className="agent-connector__remove-btn"
                    onClick={() => handleRemoveHeader(index)}
                  >
                    ×
                  </button>
                </div>
              ))}
              <button
                type="button"
                className="agent-connector__add-header-btn"
                onClick={handleAddHeader}
              >
                + Add Header
              </button>
            </div>
          )}
        </>
      )}

      <div className="agent-connector__field">
        <label className="agent-connector__label" htmlFor="identifyagentstep-what-does-this-collaborator-do">What does this collaborator do?</label>
        <textarea id="identifyagentstep-what-does-this-collaborator-do"
          className="agent-connector__input"
          value={state.description}
          onChange={(e) => updateState({ description: e.target.value })}
          placeholder="Describe this collaborator's responsibilities..."
          rows={3}
          style={{ resize: 'vertical', minHeight: '80px' }}
        />
      </div>

      <div className="agent-connector-nav">
        <Button
          variant="primary"
          onClick={onCheckConnection}
          disabled={!isValid}
          loading={isLoading}
        >
          Check Connection
        </Button>
      </div>
    </div>
  )
}
