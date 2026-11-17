/**
 * A custom API whose provider has changed its API says so on the CARD.
 *
 * The connection still works — the key is fine, the verification call passes —
 * so nothing about it looks wrong, and a person has no reason to open it. The
 * finding has to be where they already are, and said the way this card says
 * everything else about itself: a status beside Connected and Needs Reconnect,
 * not a sentence inside a modal nobody opened.
 *
 * It is NOT Needs Reconnect. That word sends a card to the connect flow to put
 * a new key in, and there is nothing wrong with this key.
 */
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
  useDeleteConnector: () => ({ mutate: vi.fn(), isPending: false }),
  useConnectors: () => ({ data: [], isPending: false }),
}))
vi.mock('../../hooks/useConnectorCatalog', () => ({
  useConnectorCatalog: () => ({ supportsConnection: () => true }),
}))

function customApi(id: string, name: string, config: Record<string, unknown>) {
  return {
    id,
    name,
    type: 'Infrastructure',
    icon: null,
    status: 'connected' as const,
    objectsCovered: [],
    connectorType: 'custom_api_connector',
    connector: {
      id,
      tenantId: 't1',
      type: 'custom_api_connector',
      name,
      status: 'active',
      config,
      lastSyncAt: null,
      createdAt: '',
      updatedAt: '',
    },
  }
}

vi.mock('../../hooks/useIntegrations', () => ({
  useIntegrations: () => ({
    connected: [
      customApi('c-moved', 'NASA Astronomy Picture of the Day', {
        baseUrl: 'https://api.nasa.gov',
        specDrifted: true,
      }),
      customApi('c-current', 'Acme CRM', {
        baseUrl: 'https://api.acme.example',
        specDrifted: false,
      }),
    ],
    pendingApproval: [],
    available: [],
    planned: [],
    isPending: false,
  }),
}))

vi.mock('../../components', async () => {
  const actual = await vi.importActual<typeof import('../../components')>('../../components')
  return { ...actual, PageHeader: ({ title }: { title?: string }) => <h1>{title}</h1> }
})
// Imported by path, not through the barrel, so it is stubbed by path.
vi.mock('../../components/ManageCustomApiConnectionModal', () => ({
  default: ({ displayName }: { displayName: string }) => (
    <div data-testid="manage-modal">Manage: {displayName}</div>
  ),
}))

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>
        <ConnectionsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('ConnectionsPage — a custom API whose provider moved', () => {
  it('says Needs Update, and only on the connection that moved', () => {
    renderPage()

    expect(screen.getAllByText('Needs Update')).toHaveLength(1)
    // The one that did not move is untouched, and neither is offered the
    // reconnect flow: the key is fine on both.
    expect(screen.queryByText('Needs Reconnect')).toBeNull()
    expect(screen.queryByRole('button', { name: /^Reconnect$/i })).toBeNull()
  })

  it('still opens Manage, because the connection works', () => {
    renderPage()

    fireEvent.click(screen.getAllByRole('button', { name: /Manage/i })[0]!)
    expect(screen.getByTestId('manage-modal')).toBeTruthy()
  })
})
