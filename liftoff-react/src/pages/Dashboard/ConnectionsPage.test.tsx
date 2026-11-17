import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
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

const integrationFor = (id: string, label: string) => ({
  id,
  name: 'Gmail',
  type: 'Communications',
  icon: null,
  status: 'connected' as const,
  objectsCovered: ['Email'],
  connectorType: 'google_mail' as const,
  connector: {
    id,
    tenantId: 't1',
    type: 'google_mail',
    name: 'Gmail',
    status: 'active',
    config: { externalAccountId: `google-${label}`, externalAccountLabel: label },
    lastSyncAt: null,
    createdAt: '',
    updatedAt: '',
  },
})

vi.mock('../../hooks/useIntegrations', () => ({
  useIntegrations: () => ({
    connected: [
      integrationFor('c-gmail-1', 'person@example.com'),
      integrationFor('c-gmail-2', 'support-bot@example.com'),
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
    // Stub PageHeader to avoid pulling in router-context dependencies.
    PageHeader: ({ title }: { title?: string }) => <h1>{title}</h1>,
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

describe('ConnectionsPage — per-instance Gmail cards', () => {
  it('renders two Gmail Connected cards with distinct email subtitles', () => {
    renderWithProviders(<ConnectionsPage />)

    // Two cards, each with their email shown as the subtitle.
    expect(screen.getByText('person@example.com')).toBeTruthy()
    expect(screen.getByText('support-bot@example.com')).toBeTruthy()

    // Both card headings are 'Gmail'.
    const gmailHeadings = screen.getAllByRole('heading', { name: 'Gmail' })
    expect(gmailHeadings.length).toBe(2)

    // Subtitle is the email — NOT the connector name "Gmail" duplicated.
    // Sanity check: no card has the connector display name as its subtitle
    // (we'd see 4 occurrences of "Gmail" total if it did: 2 headings + 2 subtitles).
    const gmailMatches = screen.getAllByText(/^Gmail$/)
    expect(gmailMatches.length).toBe(2) // headings only
  })
})
