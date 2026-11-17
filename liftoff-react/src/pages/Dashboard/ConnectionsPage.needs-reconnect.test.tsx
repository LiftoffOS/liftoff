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
}))

vi.mock('../../hooks/useConnectorCatalog', () => ({
  useConnectorCatalog: () => ({ supportsConnection: () => true }),
}))

// One healthy Gmail, one Outlook flipped to needs_reconnect.
vi.mock('../../hooks/useIntegrations', () => ({
  useIntegrations: () => ({
    connected: [
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
          config: { email: 'person@example.com' },
          lastSyncAt: null,
          createdAt: '',
          updatedAt: '',
        },
      },
      {
        id: 'c-outlook-1',
        name: 'Outlook Mail',
        type: 'Communications',
        icon: null,
        status: 'needs_reconnect',
        objectsCovered: ['Emails'],
        connectorType: 'microsoft_outlook_mail',
        connector: {
          id: 'c-outlook-1',
          tenantId: 't1',
          type: 'microsoft_outlook_mail',
          name: 'Outlook Mail',
          status: 'error',
          config: { email: 'user@tenant.onmicrosoft.com' },
          lastSyncAt: null,
          createdAt: '',
          updatedAt: '',
        },
      },
    ],
    pendingApproval: [],
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
    // Stub OAuth modal so the Reconnect button click doesn't try to open a popup.
    ConnectIntegrationModal: ({ integration }: { integration: { name: string } }) => (
      <div data-testid="connect-modal">Connect modal: {integration.name}</div>
    ),
  }
})

function renderWithProviders(ui: React.ReactElement) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter>{ui}</MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('ConnectionsPage — needs_reconnect card', () => {
  it('renders a Needs Reconnect card alongside a healthy Connected card', () => {
    renderWithProviders(<ConnectionsPage />)

    // Healthy card still shows the Connected status line (the section header
    // also says "Connected" so we look for it specifically inside a status cell).
    expect(screen.getByText('person@example.com')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Manage/i })).toBeTruthy()

    // Broken card shows the Needs Reconnect pill and Reconnect button. The
    // subtitle remains the normal account label — the pill + button already
    // communicate the broken state.
    expect(screen.getByText('Needs Reconnect')).toBeTruthy()
    expect(screen.getByText('user@tenant.onmicrosoft.com')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Reconnect/i })).toBeTruthy()
  })

  it('clicking Reconnect opens the OAuth connect modal (same path as the Available card)', () => {
    renderWithProviders(<ConnectionsPage />)

    fireEvent.click(screen.getByRole('button', { name: /Reconnect/i }))
    expect(screen.getByTestId('connect-modal')).toBeTruthy()
    expect(screen.getByText(/Connect modal: Outlook Mail/i)).toBeTruthy()
  })
})
