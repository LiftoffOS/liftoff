import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useIntegrations } from './useIntegrations'

// Stub icons (their JSX isn't relevant to the data shape under test)
vi.mock('../components/icons/integrationIconRegistry', () => ({
  getIntegrationIcon: () => null,
}))

vi.mock('./useConnectorCatalog', () => ({
  useConnectorCatalog: () => ({
    connectors: [
      {
        type: 'google_mail',
        displayName: 'Gmail',
        category: 'Communications',
        status: 'available',
        auth: { kind: 'oauth' },
        objectsCovered: ['Email'],
      },
      {
        type: 'slack',
        displayName: 'Slack',
        category: 'Communications',
        status: 'available',
        auth: { kind: 'oauth' },
        objectsCovered: ['Message'],
      },
    ],
    isLoading: false,
    labelForCategory: (k: string) => k,
  }),
}))

const mockLiveConnectors: Array<Record<string, unknown>> = []
vi.mock('./useConnectors', () => ({
  useConnectors: () => ({ data: mockLiveConnectors, isPending: false }),
}))

describe('useIntegrations', () => {
  it('returns 2 entries in `connected` when 2 active Gmail connectors exist (per-instance)', () => {
    mockLiveConnectors.length = 0
    mockLiveConnectors.push(
      {
        id: 'c-gmail-1',
        tenantId: 't1',
        type: 'google_mail',
        name: 'Gmail',
        status: 'active',
        config: { email: 'person@example.com' },
      },
      {
        id: 'c-gmail-2',
        tenantId: 't1',
        type: 'google_mail',
        name: 'Gmail',
        status: 'active',
        config: { email: 'support-bot@example.com' },
      },
    )

    const { result } = renderHook(() => useIntegrations())

    expect(result.current.connected).toHaveLength(2)
    const ids = result.current.connected.map((c) => c.id).sort()
    expect(ids).toEqual(['c-gmail-1', 'c-gmail-2'])

    // Gmail is still present in `available` so user can add another instance.
    expect(result.current.available.some((i) => i.connectorType === 'google_mail')).toBe(true)
  })

  it('exposes connector.config so the UI can render an email subtitle', () => {
    mockLiveConnectors.length = 0
    mockLiveConnectors.push({
      id: 'c-gmail-1',
      tenantId: 't1',
      type: 'google_mail',
      name: 'Gmail',
      status: 'active',
      config: { email: 'person@example.com' },
    })

    const { result } = renderHook(() => useIntegrations())
    const card = result.current.connected[0]
    expect((card.connector?.config as { email?: string } | undefined)?.email).toBe(
      'person@example.com',
    )
  })

  it('filters out non-active connectors from `connected`', () => {
    mockLiveConnectors.length = 0
    mockLiveConnectors.push({
      id: 'c-gmail-1',
      tenantId: 't1',
      type: 'google_mail',
      name: 'Gmail',
      status: 'pending',
      config: {},
    })

    const { result } = renderHook(() => useIntegrations())
    expect(result.current.connected).toHaveLength(0)
  })

  it('surfaces status=error connectors as needs_reconnect (not filtered out)', () => {
    mockLiveConnectors.length = 0
    mockLiveConnectors.push({
      id: 'c-gmail-1',
      tenantId: 't1',
      type: 'google_mail',
      name: 'Gmail',
      status: 'error',
      config: { email: 'person@example.com' },
    })

    const { result } = renderHook(() => useIntegrations())
    expect(result.current.connected).toHaveLength(1)
    expect(result.current.connected[0].status).toBe('needs_reconnect')
  })

  it('mixes active and needs_reconnect connectors in `connected`', () => {
    mockLiveConnectors.length = 0
    mockLiveConnectors.push(
      {
        id: 'c-gmail-1',
        tenantId: 't1',
        type: 'google_mail',
        name: 'Gmail',
        status: 'active',
        config: { email: 'person@example.com' },
      },
      {
        id: 'c-slack-1',
        tenantId: 't1',
        type: 'slack',
        name: 'Slack',
        status: 'error',
        config: {},
      },
    )

    const { result } = renderHook(() => useIntegrations())
    expect(result.current.connected).toHaveLength(2)
    const byType = Object.fromEntries(
      result.current.connected.map((c) => [c.connectorType, c.status]),
    )
    expect(byType).toEqual({
      google_mail: 'connected',
      slack: 'needs_reconnect',
    })
  })
})
