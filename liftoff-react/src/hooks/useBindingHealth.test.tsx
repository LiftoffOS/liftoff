import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useBindingHealth } from './useBindingHealth'
import type { Connector } from '../services/connections'
import type { IntegrationPermission } from '../services/internalAgents'

// Catalog entries stand in for the real /api/connectors/catalog payload. Only
// `type`, `displayName` and `auth.kind` are read by the hook.
const CATALOG = [
  { type: 'google_mail', displayName: 'Gmail', auth: { kind: 'static_oauth' } },
  { type: 'google_slides', displayName: 'Google Slides', auth: { kind: 'static_oauth' } },
  { type: 'salesforce', displayName: 'Salesforce', auth: { kind: 'api_key' } },
  { type: 'google_bigquery', displayName: 'BigQuery', auth: { kind: 'iam_grant' } },
  { type: 'custom_mcp_server', displayName: 'MCP Server', auth: { kind: 'custom_mcp' } },
]

let catalogLoading = false
vi.mock('./useConnectorCatalog', () => ({
  useConnectorCatalog: () => ({
    byType: new Map(CATALOG.map(c => [c.type, c])),
    isLoading: catalogLoading,
  }),
}))

let mockConnectors: Connector[] = []
let connectorsPending = false
vi.mock('./useConnectors', () => ({
  useConnectors: () => ({ data: mockConnectors, isPending: connectorsPending }),
}))

function connector(over: Partial<Connector> & Pick<Connector, 'id' | 'type' | 'status'>): Connector {
  return {
    tenantId: 't1',
    name: over.type,
    config: {},
    lastSyncAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...over,
  } as Connector
}

function binding(id: string, integrationId: string): IntegrationPermission {
  return { id, integrationId, selectedObjects: [] }
}

function evaluate(integrations: IntegrationPermission[] | null) {
  const { result } = renderHook(() => useBindingHealth())
  return result.current(integrations)
}

beforeEach(() => {
  mockConnectors = []
  connectorsPending = false
  catalogLoading = false
})

describe('useBindingHealth', () => {
  it('reports healthy when the bound connector is active', () => {
    mockConnectors = [connector({ id: 'c1', type: 'google_mail', status: 'active' })]
    expect(evaluate([binding('c1', 'google_mail')]).isBroken).toBe(false)
  })

  it('treats a connector still mid-connect as healthy, not as a fault', () => {
    mockConnectors = [connector({ id: 'c1', type: 'google_mail', status: 'pending' })]
    expect(evaluate([binding('c1', 'google_mail')]).isBroken).toBe(false)
  })

  // The false-positive guard. platform-backend enriches bindings with `type`
  // precisely because the UUID goes stale, and the runtime binds a manifest by
  // type when there is exactly one of each. A UUID-equality check would report
  // this team as broken while it runs perfectly well.
  it('resolves a stale UUID through the sole-live-connector-of-this-type rule', () => {
    mockConnectors = [connector({ id: 'c-new', type: 'google_mail', status: 'active' })]
    expect(evaluate([binding('c-old', 'google_mail')]).isBroken).toBe(false)
  })

  it('does not apply the sole-of-type rule when the team holds two bindings of that type', () => {
    mockConnectors = [connector({ id: 'c-new', type: 'google_mail', status: 'active' })]
    const health = evaluate([binding('c-old-1', 'google_mail'), binding('c-old-2', 'google_mail')])
    expect(health.isBroken).toBe(true)
    expect(health.broken).toHaveLength(2)
  })

  it('does not apply the sole-of-type rule when two connectors of that type are live', () => {
    mockConnectors = [
      connector({ id: 'c-a', type: 'google_mail', status: 'active' }),
      connector({ id: 'c-b', type: 'google_mail', status: 'active' }),
    ]
    expect(evaluate([binding('c-old', 'google_mail')]).isBroken).toBe(true)
  })

  it('flags a revoked credential and asks for a reconnect', () => {
    mockConnectors = [connector({ id: 'c1', type: 'google_mail', status: 'error' })]
    const health = evaluate([binding('c1', 'google_mail')])
    expect(health.broken[0]).toMatchObject({ reason: 'needs_reconnect', recovery: 'reconnect' })
    expect(health.message).toBe('Gmail needs to be reconnected. Until then this agent cannot use it.')
  })

  it('flags a connector that no longer exists at all', () => {
    const health = evaluate([binding('c-gone', 'google_slides')])
    expect(health.broken[0]).toMatchObject({ reason: 'gone', connectorType: 'google_slides' })
    expect(health.message).toBe('Google Slides is no longer connected. Connect it again to restore this agent.')
  })

  // The disconnect case, end to end with the backend change that stopped
  // scrubbing the binding on connector.deleted. A disconnected connector is
  // soft-deleted and filtered out of GET /api/connectors, so the client sees
  // the surviving binding point at nothing — which is the state that finally
  // lets the Teams page say something instead of dropping an icon in silence.
  it('flags a binding whose connector the user disconnected', () => {
    mockConnectors = []
    const health = evaluate([binding('c-disconnected', 'google_mail')])
    expect(health.broken[0]).toMatchObject({ reason: 'gone', connectorType: 'google_mail' })
    expect(health.message).toBe('Gmail is no longer connected. Connect it again to restore this agent.')
  })

  // Disconnecting one Gmail while a second stays live is not a broken team:
  // the runtime binds the surviving manifest of that type, so the badge must
  // not fire.
  it('stays healthy when a second connector of the same type is still live', () => {
    mockConnectors = [connector({ id: 'c-other', type: 'google_mail', status: 'active' })]
    expect(evaluate([binding('c-disconnected', 'google_mail')]).isBroken).toBe(false)
  })

  it('asks an api-key connector for credentials, not a reconnect', () => {
    mockConnectors = [connector({ id: 'c1', type: 'salesforce', status: 'error' })]
    expect(evaluate([binding('c1', 'salesforce')]).message).toBe(
      'Salesforce needs new credentials. Until then this agent cannot use it.',
    )
  })

  it('asks BigQuery to be re-granted and verified', () => {
    mockConnectors = [connector({ id: 'c1', type: 'google_bigquery', status: 'error' })]
    expect(evaluate([binding('c1', 'google_bigquery')]).message).toBe(
      'BigQuery access could not be verified. Re-grant access and verify it to restore this agent.',
    )
  })

  // A customer-hosted MCP server is hard-deleted, so it only ever shows up as
  // gone, and there is no reconnect flow to send anyone to.
  it('tells a removed MCP server to be added again', () => {
    expect(evaluate([binding('c-gone', 'custom_mcp_server')]).message).toBe(
      'MCP Server was removed. Add the MCP server again to restore this agent.',
    )
  })

  it('names the MCP server the customer chose rather than the catalog label', () => {
    mockConnectors = [connector({ id: 'c1', type: 'custom_mcp_server', status: 'error', name: 'Help Center MCP' })]
    expect(evaluate([binding('c1', 'custom_mcp_server')]).message).toContain('Help Center MCP')
  })

  it('summarises more than one broken connection', () => {
    mockConnectors = [connector({ id: 'c1', type: 'salesforce', status: 'error' })]
    const health = evaluate([binding('c1', 'salesforce'), binding('c-gone', 'google_slides')])
    expect(health.message).toBe('2 connections need attention: Salesforce and Google Slides.')
  })

  // Peer-agent bindings live in the same array and point at an agent, not a
  // connector. Judging them would badge every team that delegates.
  it('ignores bindings that do not name a catalog connector type', () => {
    const peer: IntegrationPermission = { id: 'agent-uuid', selectedObjects: [] }
    expect(evaluate([peer]).isBroken).toBe(false)
    expect(evaluate([{ ...peer, integrationId: 'external_agent' }]).isBroken).toBe(false)
  })

  it('reports healthy while the connector list is still loading', () => {
    connectorsPending = true
    expect(evaluate([binding('c-gone', 'google_slides')]).isBroken).toBe(false)
  })

  it('reports healthy while the catalog is still loading', () => {
    catalogLoading = true
    expect(evaluate([binding('c-gone', 'google_slides')]).isBroken).toBe(false)
  })

  it('reports healthy for a team with no bindings', () => {
    expect(evaluate([]).isBroken).toBe(false)
    expect(evaluate(null).isBroken).toBe(false)
  })
})
