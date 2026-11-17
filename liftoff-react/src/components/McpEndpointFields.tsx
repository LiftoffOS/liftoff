// McpEndpointFields — shared form section for "an MCP endpoint + how to
// authenticate against it." Used by:
//   - ConnectCustomMcpServerModal (Connections page)
//   - IdentifyAgentStep (Connect External Agent wizard) — via the
//     same modal-launch pattern
//
// Each consumer owns its outer state; this component is fully controlled.
// What it renders, in order:
//   1. MCP endpoint URL TextInput
//   2. "Use a tunnel" Button — clicking opens a nested ModalOverlay
//      containing <TunnelSetup />. On commit the routed URL populates the
//      URL field above and the modal closes.
//   3. Authentication Dropdown (full width via .mcp-endpoint__field wrapper)
//   4. Auth-specific fields (api_key / bearer_token / custom_headers)
//
// Inline rendering of TunnelSetup was removed — it now ALWAYS displays in
// its own ModalOverlay so the surrounding form doesn't reflow when the
// customer expands the tunnel-setup affordance.

import { useState } from 'react'
import Button from './Button'
import { Dropdown, type DropdownOption } from './Dropdown'
import ModalOverlay from './ModalOverlay'
import TextInput from './TextInput/TextInput'
import TunnelSetup from './TunnelSetup'
import './McpEndpointFields.css'

export type McpAuthType = 'none' | 'api_key' | 'bearer_token' | 'custom_headers'

export interface McpCustomHeader {
  key: string
  value: string
}

export interface McpEndpointFieldsValue {
  endpointUrl: string
  authType: McpAuthType
  apiKey: string
  bearerToken: string
  customHeaders: McpCustomHeader[]
  tunnelRouteId: string | null
}

interface McpEndpointFieldsProps {
  value: McpEndpointFieldsValue
  onChange: (next: McpEndpointFieldsValue) => void
  /** Drives TunnelSetup labels. */
  entityKind: 'agent' | 'mcp_server'
  /** Used to slugify into the auto-derived tunnel subdomain. */
  entityName: string
  disabled?: boolean
  /** Label of the URL field. */
  urlLabel?: string
}

const AUTH_OPTIONS: DropdownOption[] = [
  { value: 'none', label: 'None' },
  { value: 'api_key', label: 'API key' },
  { value: 'bearer_token', label: 'Bearer token' },
  { value: 'custom_headers', label: 'Custom headers' },
]

export default function McpEndpointFields({
  value,
  onChange,
  entityKind,
  entityName,
  disabled = false,
  urlLabel = 'MCP endpoint URL',
}: McpEndpointFieldsProps) {
  const [tunnelModalOpen, setTunnelModalOpen] = useState(false)

  const patch = (next: Partial<McpEndpointFieldsValue>) => {
    onChange({ ...value, ...next })
  }

  const updateHeader = (index: number, fieldPatch: Partial<McpCustomHeader>) => {
    const next = value.customHeaders.map((h, i) =>
      i === index ? { ...h, ...fieldPatch } : h,
    )
    patch({ customHeaders: next })
  }

  const removeHeader = (index: number) => {
    patch({ customHeaders: value.customHeaders.filter((_, i) => i !== index) })
  }

  const addHeader = () => {
    patch({ customHeaders: [...value.customHeaders, { key: '', value: '' }] })
  }

  return (
    <>
      <TextInput
        id="mcp-endpoint-url"
        label={urlLabel}
        type="url"
        value={value.endpointUrl}
        onChange={(e) => patch({ endpointUrl: e.target.value })}
        placeholder={
          entityKind === 'agent'
            ? 'https://agent.example.com/mcp'
            : 'https://mcp.acme.com/mcp'
        }
        autoComplete="off"
        disabled={disabled}
      />

      <div className="mcp-endpoint__tunnel-trigger">
        <Button
          variant="outline"
          size="sm"
          onClick={() => setTunnelModalOpen(true)}
          disabled={disabled}
        >
          Use A Tunnel
        </Button>
      </div>

      {tunnelModalOpen && (
        <ModalOverlay onClose={() => setTunnelModalOpen(false)}>
          <h2 className="connection-modal__title">Set Up A Tunnel</h2>
          <p className="connection-modal__description">
            Run a small Docker container in your network and route it to the
            private service you want to expose.
          </p>
          <TunnelSetup
            entityName={entityName || (entityKind === 'agent' ? 'collaborator' : 'mcp-server')}
            entityKind={entityKind}
            onCommit={({ tunnelRouteId, publicUrl }) => {
              patch({ tunnelRouteId, endpointUrl: publicUrl })
              setTunnelModalOpen(false)
            }}
            onCancel={() => setTunnelModalOpen(false)}
          />
        </ModalOverlay>
      )}

      <div className="mcp-endpoint__field">
        <label className="mcp-endpoint__label" htmlFor="mcp-auth-type">
          Authentication
        </label>
        <Dropdown
          options={AUTH_OPTIONS}
          value={value.authType}
          onChange={(v) => patch({ authType: v as McpAuthType })}
          disabled={disabled}
        />
      </div>

      {value.authType === 'api_key' && (
        <TextInput
          id="mcp-auth-apikey"
          label="API key"
          type="password"
          value={value.apiKey}
          onChange={(e) => patch({ apiKey: e.target.value })}
          placeholder="Enter your API key"
          autoComplete="off"
          disabled={disabled}
        />
      )}

      {value.authType === 'bearer_token' && (
        <TextInput
          id="mcp-auth-bearer"
          label="Bearer token"
          type="password"
          value={value.bearerToken}
          onChange={(e) => patch({ bearerToken: e.target.value })}
          placeholder="Enter your bearer token"
          autoComplete="off"
          disabled={disabled}
        />
      )}

      {value.authType === 'custom_headers' && (
        <div className="mcp-endpoint__header-rows">
          {value.customHeaders.map((h, i) => (
            <div key={i} className="mcp-endpoint__header-row">
              <TextInput
                id={`mcp-auth-header-key-${i}`}
                value={h.key}
                onChange={(e) => updateHeader(i, { key: e.target.value })}
                placeholder="Header name"
                autoComplete="off"
                disabled={disabled}
              />
              <TextInput
                id={`mcp-auth-header-value-${i}`}
                type="password"
                value={h.value}
                onChange={(e) => updateHeader(i, { value: e.target.value })}
                placeholder="Header value"
                autoComplete="off"
                disabled={disabled}
              />
              <button
                type="button"
                className="mcp-endpoint__remove-btn"
                onClick={() => removeHeader(i)}
                disabled={disabled}
                aria-label="Remove header"
              >
                ×
              </button>
            </div>
          ))}
          <button
            type="button"
            className="mcp-endpoint__add-row-btn"
            onClick={addHeader}
            disabled={disabled}
          >
            + Add Header
          </button>
        </div>
      )}
    </>
  )
}
