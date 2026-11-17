// The shape an install produces.
//
// Installing the App does NOT amend the OAuth row. It creates a SECOND
// connector row for the installed account, so a tenant holds one row per
// account plus the original user-token row:
//
//   7d07a896  active        {externalAccountLabel: "octocat"}                 <- OAuth leg, no App
//   dd4c4689  active        {installationId: 12345678, "acme", all repos}     <- the installation
//   379d6517  disconnected  {import_source: "openclaw"}                       <- import placeholder
//
// Every card is titled "GitHub", so the subtitle is the only thing telling them
// apart. Getting that wrong renders two identical cards.

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

function seedRows() {
  mockLiveConnectors.length = 0
  mockLiveConnectors.push(
    {
      id: '7d07a896-89f6-4f5c-8a26-1186c9fcf270',
      tenantId: 't1',
      type: 'github',
      name: 'GitHub',
      status: 'active',
      config: {
        scopes: ['repo', 'read:user', 'user:email', 'read:org'],
        bot_login: 'octocat',
        externalAccountId: '583231',
        externalAccountLabel: 'octocat',
      },
    },
    {
      id: 'dd4c4689-e1d6-4464-8592-f8fdac0edf0d',
      tenantId: 't1',
      type: 'github',
      name: 'GitHub (acme)',
      status: 'active',
      config: {
        installState: 'installed',
        installationId: 12345678,
        githubAccountId: 100000001,
        awaitingOrgLogin: null,
        externalAccountId: '100000001',
        githubAccountType: 'Organization',
        repositorySelection: 'all',
        externalAccountLabel: 'acme',
      },
    },
    {
      id: '379d6517-7f24-4102-ba91-9358c248d4f1',
      tenantId: 't1',
      type: 'github',
      name: 'GitHub (import)',
      status: 'disconnected',
      config: { import_source: 'openclaw', disconnect_reason: 'source_import' },
    },
  )
}

describe('useIntegrations — a tenant with an App installed alongside the OAuth row', () => {
  it('renders one card per live row', () => {
    seedRows()
    const { result } = renderHook(() => useIntegrations())
    expect(result.current.connected).toHaveLength(2)
  })

  it('gives every card a distinct id, so React does not collapse them', () => {
    seedRows()
    const { result } = renderHook(() => useIntegrations())
    const ids = result.current.connected.map((c) => c.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('titles both "GitHub" and never leaks the row name suffix', () => {
    // The row `name` carries a "(login)" suffix purely to satisfy a UNIQUE
    // constraint. Surfacing it as a card title is the failure mode.
    seedRows()
    const { result } = renderHook(() => useIntegrations())
    expect(result.current.connected.map((c) => c.name)).toEqual(['GitHub', 'GitHub'])
  })

  it('excludes the disconnected import placeholder', () => {
    seedRows()
    const { result } = renderHook(() => useIntegrations())
    const ids = result.current.connected.map((c) => c.id)
    expect(ids).not.toContain('379d6517-7f24-4102-ba91-9358c248d4f1')
    expect(result.current.pendingApproval).toHaveLength(0)
  })

  it('carries the config each card needs to tell itself apart', () => {
    seedRows()
    const { result } = renderHook(() => useIntegrations())
    const byAccount = Object.fromEntries(
      result.current.connected.map((c) => [
        (c.connector?.config as { externalAccountLabel?: string })?.externalAccountLabel,
        c.connector?.config as Record<string, unknown>,
      ]),
    )

    // The OAuth row has no App: no repository scope, no disconnect warning.
    expect(byAccount.octocat.installationId).toBeUndefined()
    expect(byAccount.octocat.repositorySelection).toBeUndefined()

    // The installation row drives "All repositories" and the disconnect warning.
    expect(byAccount.acme.installationId).toBe(12345678)
    expect(byAccount.acme.repositorySelection).toBe('all')
  })
})
