// The two GitHub App card states, and the disconnect that is no longer the
// whole truth.
//
// Deleting our connector row does NOT uninstall the App: Liftoff keeps the
// write access it was granted until someone removes the installation in GitHub.
// A user who disconnects believing they revoked access would be wrong, so the
// modal has to say so.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import ConnectionsPage from './ConnectionsPage'

vi.mock('../../contexts/AuthContext', () => ({
  // Connecting and managing are owner/admin, so these tests act as an owner:
  // what they assert is the connection behaviour, not the permission.
  useAuth: () => ({ currentTenant: { id: 't1' }, currentRole: 'owner' }),
}))

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}))

vi.mock('../../hooks/useConnectors', () => ({
  useDeleteConnector: () => ({ mutate: vi.fn(), mutateAsync: vi.fn(), isPending: false }),
}))

vi.mock('../../hooks/useConnectorCatalog', () => ({
  useConnectorCatalog: () => ({ supportsConnection: () => true }),
}))

vi.mock('../../hooks/useIntegrations', () => ({
  useIntegrations: () => ({
    connected: [
      {
        id: 'c-github-1',
        name: 'GitHub',
        type: 'Engineering',
        icon: null,
        status: 'connected',
        objectsCovered: ['Pull request'],
        connectorType: 'github',
        connector: {
          id: 'c-github-1',
          tenantId: 't1',
          type: 'github',
          name: 'GitHub',
          status: 'active',
          config: {
            installationId: 4711,
            installState: 'installed',
            externalAccountLabel: 'acme',
            repositorySelection: 'selected',
            repositoryCount: 4,
          },
          lastSyncAt: null,
          createdAt: '',
          updatedAt: '',
        },
      },
    ],
    pendingApproval: [
      {
        id: 'github:pending:c-github-2',
        name: 'GitHub',
        type: 'Engineering',
        icon: null,
        status: 'pending_org_approval',
        objectsCovered: [],
        connectorType: 'github',
        connector: {
          id: 'c-github-2',
          tenantId: 't1',
          type: 'github',
          name: 'GitHub',
          status: 'pending',
          config: { installState: 'awaiting_org_approval', awaitingOrgLogin: 'acme-corp' },
          lastSyncAt: null,
          createdAt: '',
          updatedAt: '',
        },
      },
    ],
    available: [],
    planned: [],
    isPending: false,
  }),
}))

vi.mock('../../components', async () => {
  const actual = await vi.importActual<typeof import('../../components')>('../../components')
  return {
    ...actual,
    PageHeader: ({ title }: { title?: string }) => <h1>{title}</h1>,
    ConnectIntegrationModal: ({ integration }: { integration: { name: string } }) => (
      <div data-testid="connect-modal">Connect modal: {integration.name}</div>
    ),
  }
})

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><ConnectionsPage /></MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('ConnectionsPage — GitHub App cards', () => {
  it('shows an outstanding request instead of leaving the user with nothing', () => {
    renderPage()

    expect(screen.getByText('Waiting for approval')).toBeTruthy()
    expect(screen.getByText(/An owner of acme-corp needs to approve/)).toBeTruthy()
  })

  it('names the repository scope without inventing a total', () => {
    renderPage()

    expect(screen.getByText('4 repositories')).toBeTruthy()
    expect(screen.queryByText(/\d+ of \d+ repositories/)).toBeNull()
  })

  it('labels the connected card from the account the backend read, not the picker', () => {
    renderPage()

    expect(screen.getByText('acme')).toBeTruthy()
  })

  it('warns that disconnecting leaves the installation in place', () => {
    renderPage()

    fireEvent.click(screen.getAllByRole('button', { name: /Manage/i })[1])

    expect(screen.getByText(/The Liftoff app stays installed in GitHub/)).toBeTruthy()
    expect(screen.getByRole('link', { name: /Manage the installation on GitHub/i })).toBeTruthy()
  })

  it('does not claim a pending request can be withdrawn from here', () => {
    renderPage()

    fireEvent.click(screen.getAllByRole('button', { name: /Manage/i })[0])

    expect(screen.getByText(/will not withdraw the request in GitHub/)).toBeTruthy()
  })
})
