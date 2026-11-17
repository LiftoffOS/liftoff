import { describe, it, expect } from 'vitest'
import { permissionsToSelected } from './permissionsToSelected'
import type { Integration } from '../hooks/useIntegrations'

const catalog: Integration[] = [
  {
    id: 'google_mail',
    name: 'Gmail',
    type: 'Communications',
    icon: null,
    status: 'available',
    objectsCovered: ['Email'],
    connectorType: 'google_mail',
    connector: undefined,
  },
  {
    id: 'c-gmail-1',
    name: 'Gmail',
    type: 'Communications',
    icon: null,
    status: 'connected',
    objectsCovered: ['Email'],
    connectorType: 'google_mail',
    connector: {
      id: 'c-gmail-1',
      tenantId: 't1',
      type: 'google_mail',
      name: 'Gmail',
      status: 'active',
      config: { email: 'support-bot@example.com' },
      lastSyncAt: null,
      createdAt: '',
      updatedAt: '',
    },
  },
  // Multi-instance: useIntegrations sets id="${type}:${connectorUuid}" so the
  // connected entry can be deduped from catalog entries. Used in the
  // legacy-composite normalisation tests below.
  {
    id: 'custom_mcp_server:mcp-uuid-1',
    name: 'My MCP',
    type: 'Custom',
    icon: null,
    status: 'connected',
    objectsCovered: [],
    connectorType: 'custom_mcp_server',
    connector: {
      id: 'mcp-uuid-1',
      tenantId: 't1',
      type: 'custom_mcp_server',
      name: 'My MCP',
      status: 'active',
      config: {},
      lastSyncAt: null,
      createdAt: '',
      updatedAt: '',
    },
  },
]

describe('permissionsToSelected — edit round-trip', () => {
  it('carries config (gmailQuery + sendAs) through unchanged', () => {
    const result = permissionsToSelected(
      [
        {
          id: 'c-gmail-1',
          integrationId: 'google_mail',
          selectedObjects: [],
          config: { gmailQuery: 'label:support-agent', sendAs: 'support@example.com' },
        },
      ],
      catalog,
    )
    expect(result).toHaveLength(1)
    expect(result[0]).toMatchObject({
      id: 'c-gmail-1',
      integrationId: 'google_mail',
      name: 'Gmail',
      config: { gmailQuery: 'label:support-agent', sendAs: 'support@example.com' },
    })
  })

  it('omits config when not present (no empty object on the result)', () => {
    const result = permissionsToSelected(
      [{ id: 'c-gmail-1', integrationId: 'google_mail', selectedObjects: ['Email'] }],
      catalog,
    )
    expect(result[0].config).toBeUndefined()
  })

  it('falls back to permission.id when the catalog has no match (no crash)', () => {
    const result = permissionsToSelected(
      [{ id: 'unknown-id', selectedObjects: [], config: { gmailQuery: 'label:x' } }],
      catalog,
    )
    expect(result[0]).toMatchObject({
      id: 'unknown-id',
      name: 'unknown-id',
      type: 'Unknown',
      config: { gmailQuery: 'label:x' },
    })
  })
})

describe('permissionsToSelected — integrationId normalisation', () => {
  // SelectedIntegration.integrationId is meant to be the canonical catalog
  // type (e.g. "custom_mcp_server"). Older records were saved with the
  // multi-instance composite "${type}:${connectorUuid}" because the producer
  // used Integration.id. permissionsToSelected normalises these back to the
  // canonical type on load, so the next save heals the record.

  it('normalises a legacy composite integrationId to the canonical catalog type', () => {
    const result = permissionsToSelected(
      [
        {
          id: 'mcp-uuid-1',
          integrationId: 'custom_mcp_server:mcp-uuid-1',
          selectedObjects: [],
        },
      ],
      catalog,
    )
    expect(result[0].integrationId).toBe('custom_mcp_server')
  })

  it('derives canonical type when integrationId is missing on legacy records', () => {
    const result = permissionsToSelected(
      [{ id: 'mcp-uuid-1', selectedObjects: [] }],
      catalog,
    )
    expect(result[0].integrationId).toBe('custom_mcp_server')
  })

  it('preserves already-canonical integrationId values', () => {
    const result = permissionsToSelected(
      [{ id: 'c-gmail-1', integrationId: 'google_mail', selectedObjects: [] }],
      catalog,
    )
    expect(result[0].integrationId).toBe('google_mail')
  })
})

describe('permissionsToSelected — stale-id heal after reconnect', () => {
  // When a connector is reconnected, connector-service soft-deletes the old
  // row and inserts a new one with a fresh UUID. Bindings written before the
  // reconnect point at the old UUID, which is filtered out of useConnectors.
  // permissionsToSelected resolves these to the current live connector by
  // canonical type when unambiguous, so the chip renders as bound and sorts
  // to the top of the Connected list.

  it('heals a stale single-instance UUID via perm.integrationId', () => {
    const result = permissionsToSelected(
      [{ id: 'c-gmail-OLD', integrationId: 'google_mail', selectedObjects: [] }],
      catalog,
    )
    // catalog has connected Gmail at connector.id='c-gmail-1' — the heal
    // resolves the stale OLD uuid to the current live uuid so isSelected
    // matches in IntegrationsSelector.
    expect(result[0].id).toBe('c-gmail-1')
    expect(result[0].name).toBe('Gmail')
    expect(result[0].integrationId).toBe('google_mail')
  })

  it('heals via perm.type when integrationId is absent (backend auto-grant case)', () => {
    // pending-integration-service writes `type` (not `integrationId`) on
    // OAuth-triggered auto-grants. permissionsToSelected accepts both.
    const result = permissionsToSelected(
      [{ id: 'c-gmail-OLD', type: 'google_mail', selectedObjects: [] }],
      catalog,
    )
    expect(result[0].id).toBe('c-gmail-1')
    expect(result[0].integrationId).toBe('google_mail')
  })

  it('does not heal a stale UUID when multiple live instances of that type exist', () => {
    // Add a second live Gmail instance so the heal becomes ambiguous and
    // refuses to pick. Keeps the stale id rather than guessing wrong.
    const catalogWithTwoGmails: Integration[] = [
      ...catalog,
      {
        id: 'c-gmail-2',
        name: 'Gmail',
        type: 'Communications',
        icon: null,
        status: 'connected',
        objectsCovered: ['Email'],
        connectorType: 'google_mail',
        connector: {
          id: 'c-gmail-2',
          tenantId: 't1',
          type: 'google_mail',
          name: 'Gmail',
          status: 'active',
          config: { email: 'second@example.com' },
          lastSyncAt: null,
          createdAt: '',
          updatedAt: '',
        },
      },
    ]
    const result = permissionsToSelected(
      [{ id: 'c-gmail-OLD', integrationId: 'google_mail', selectedObjects: [] }],
      catalogWithTwoGmails,
    )
    expect(result[0].id).toBe('c-gmail-OLD')
  })

  it('preserves carry-through fields (selectedObjects, config) when healing', () => {
    const result = permissionsToSelected(
      [
        {
          id: 'c-gmail-OLD',
          integrationId: 'google_mail',
          selectedObjects: ['Email'],
          config: { gmailQuery: 'label:support', sendAs: 'support@x.com' },
        },
      ],
      catalog,
    )
    expect(result[0].id).toBe('c-gmail-1')
    expect(result[0].selectedObjects).toEqual(['Email'])
    expect(result[0].config).toEqual({ gmailQuery: 'label:support', sendAs: 'support@x.com' })
  })
})
