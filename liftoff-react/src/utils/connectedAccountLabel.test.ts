import { describe, it, expect } from 'vitest'
import { connectedAccountLabel } from './connectedAccountLabel'

describe('connectedAccountLabel', () => {
  it('returns externalAccountLabel when present (canonical identity)', () => {
    expect(
      connectedAccountLabel({
        config: {
          externalAccountId: 'sf-123',
          externalAccountLabel: 'person@example.com',
        },
      }),
    ).toBe('person@example.com')
  })

  it('falls back to legacy `email` field for pre-generalization Gmail rows', () => {
    expect(connectedAccountLabel({ config: { email: 'person@example.com' } })).toBe(
      'person@example.com',
    )
  })

  it('prefers externalAccountLabel over email when both are present', () => {
    expect(
      connectedAccountLabel({
        config: {
          externalAccountLabel: 'Liftoff Workspace',
          email: 'person@example.com',
        },
      }),
    ).toBe('Liftoff Workspace')
  })

  it('falls back to serverUrl for Custom MCP Server instances', () => {
    expect(
      connectedAccountLabel({
        config: { serverUrl: 'https://mcp.example.com/sse' },
      }),
    ).toBe('https://mcp.example.com/sse')
  })

  it('falls back to mcpUrl for vendor-hosted MCP per-tenant URLs', () => {
    expect(connectedAccountLabel({ config: { mcpUrl: 'https://liftoff.snowflake.mcp.example' } })).toBe(
      'https://liftoff.snowflake.mcp.example',
    )
  })

  it('falls back to endpointUrl for custom_mcp_server (platform-backend field name)', () => {
    expect(
      connectedAccountLabel({
        config: { deliveryMode: 'public_url', endpointUrl: 'https://cdn.example.com/mcp' },
      }),
    ).toBe('https://cdn.example.com/mcp')
  })

  it('falls back to subdomain for Zendesk/BambooHR-shaped connectors', () => {
    expect(connectedAccountLabel({ config: { subdomain: 'liftoff' } })).toBe('liftoff')
  })

  it('falls back to accountIdentifier (Snowflake, Databricks-style)', () => {
    expect(connectedAccountLabel({ config: { accountIdentifier: 'xy12345' } })).toBe(
      'xy12345',
    )
  })

  it('falls back to apiKeyHint when nothing else is set', () => {
    expect(
      connectedAccountLabel({
        config: {},
        apiKeyHint: '…x4f9',
      }),
    ).toBe('…x4f9')
  })

  it('returns undefined when nothing useful is set', () => {
    expect(connectedAccountLabel(undefined)).toBeUndefined()
    expect(connectedAccountLabel(null)).toBeUndefined()
    expect(connectedAccountLabel({})).toBeUndefined()
    expect(connectedAccountLabel({ config: {} })).toBeUndefined()
    expect(connectedAccountLabel({ config: { unrelated: 'value' } })).toBeUndefined()
  })

  it('skips empty/whitespace-only string fields', () => {
    expect(
      connectedAccountLabel({
        config: {
          externalAccountLabel: '   ',
          email: 'person@example.com',
        },
      }),
    ).toBe('person@example.com')
  })

  it('canonical identity wins over URL/subdomain when both are present', () => {
    expect(
      connectedAccountLabel({
        config: {
          externalAccountLabel: 'Liftoff Workspace',
          subdomain: 'liftoff',
          serverUrl: 'https://mcp.example.com',
        },
      }),
    ).toBe('Liftoff Workspace')
  })
})
