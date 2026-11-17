// A GitHub App install that an organisation owner has not approved yet.
//
// `connected` filters to active/error rows, so a `pending` row used to vanish
// completely: the tile sat in "Available" as though nothing had happened while
// GitHub held an outstanding request against the user's org. It now surfaces,
// but in its own bucket — `connected` is read by the team builder's requirement
// gate, the file-attach picker and the switch wizard to mean "usable right
// now", and a requested install is not usable.

import { describe, it, expect, vi } from 'vitest'
import { renderHook } from '@testing-library/react'
import { useIntegrations } from './useIntegrations'

vi.mock('../components/icons/integrationIconRegistry', () => ({
  getIntegrationIcon: () => null,
}))

vi.mock('./useConnectorCatalog', () => ({
  useConnectorCatalog: () => ({
    connectors: [
      {
        type: 'github',
        displayName: 'GitHub',
        category: 'engineering',
        status: 'available',
        auth: { kind: 'static_oauth' },
        objectsCovered: ['Pull request'],
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

describe('useIntegrations — installs awaiting organisation approval', () => {
  it('surfaces a pending install instead of dropping it on the floor', () => {
    mockLiveConnectors.length = 0
    mockLiveConnectors.push({
      id: 'c-github-1',
      tenantId: 't1',
      type: 'github',
      name: 'GitHub',
      status: 'pending',
      config: { installState: 'awaiting_org_approval', awaitingOrgLogin: 'acme-corp' },
    })

    const { result } = renderHook(() => useIntegrations())

    expect(result.current.pendingApproval).toHaveLength(1)
    expect(result.current.pendingApproval[0].status).toBe('pending_org_approval')
    expect(result.current.pendingApproval[0].connector?.id).toBe('c-github-1')
  })

  it('keeps it out of `connected`, which every selector reads as usable', () => {
    mockLiveConnectors.length = 0
    mockLiveConnectors.push({
      id: 'c-github-1',
      tenantId: 't1',
      type: 'github',
      name: 'GitHub',
      status: 'pending',
      config: { installState: 'awaiting_org_approval', awaitingOrgLogin: 'acme-corp' },
    })

    const { result } = renderHook(() => useIntegrations())

    expect(result.current.connected).toHaveLength(0)
  })

  it('leaves an ordinary pending row alone', () => {
    // `pending` on any other connector is a half-finished connect, not an
    // outstanding request against an organisation. It has no card to render.
    mockLiveConnectors.length = 0
    mockLiveConnectors.push({
      id: 'c-github-2',
      tenantId: 't1',
      type: 'github',
      name: 'GitHub',
      status: 'pending',
      config: {},
    })

    const { result } = renderHook(() => useIntegrations())

    expect(result.current.pendingApproval).toHaveLength(0)
    expect(result.current.connected).toHaveLength(0)
  })

  it('reports an installed connection as connected, with its repository scope', () => {
    mockLiveConnectors.length = 0
    mockLiveConnectors.push({
      id: 'c-github-3',
      tenantId: 't1',
      type: 'github',
      name: 'GitHub',
      status: 'active',
      config: {
        installationId: 555,
        installState: 'installed',
        externalAccountLabel: 'acme',
        repositorySelection: 'selected',
        repositoryCount: 4,
      },
    })

    const { result } = renderHook(() => useIntegrations())

    expect(result.current.pendingApproval).toHaveLength(0)
    expect(result.current.connected).toHaveLength(1)
    expect(result.current.connected[0].status).toBe('connected')
  })
})
