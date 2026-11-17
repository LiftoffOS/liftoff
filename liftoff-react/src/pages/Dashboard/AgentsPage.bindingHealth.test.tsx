// An agent whose connector binding no longer resolves used to render a plain
// "Active" in the Status column. The integration icon quietly disappeared and
// nothing else changed, so a team that could not do its job looked identical to
// one that could. These pin the badge, its copy, and the precedence rule.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import AgentsPage from './AgentsPage'
import type { InternalAgent } from '../../services/internalAgents'
import type { Connector } from '../../services/connections'

class ResizeObserverMock {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}
global.ResizeObserver = ResizeObserverMock

vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router')
  return { ...actual, useNavigate: () => vi.fn() }
})

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ canManageMembers: true, currentRole: 'member', currentTenant: { id: 't1', name: 'T' } }),
}))
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}))
vi.mock('../../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ liftoffScoreEnabled: false }),
}))
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }))

const idleMutation = () => ({ mutate: vi.fn(), isPending: false, variables: undefined })
vi.mock('../../hooks/useInternalAgents', () => ({
  useDeleteInternalAgent: () => idleMutation(),
  useUpdateInternalAgentStatus: () => idleMutation(),
}))
vi.mock('../../hooks/useExternalAgents', () => ({
  useDeleteExternalAgent: () => idleMutation(),
  useUpdateExternalAgentStatus: () => idleMutation(),
}))
vi.mock('../../hooks/useClaudeCodeProxy', () => ({
  useDeleteClaudeCodeProxyKey: () => idleMutation(),
  useRevokeMcpToken: () => idleMutation(),
}))
vi.mock('../../hooks/usePersonAssignments', () => ({
  useOnboardStatuses: () => ({ data: undefined, isPending: false }),
}))
vi.mock('../../hooks/useAgentStats', () => ({
  useAgentStats: () => ({ activeTeams: 0, tasksCompletedLast30Days: 0, hoursSavedLast30Days: 0 }),
}))

const CATALOG = [
  { type: 'github', displayName: 'GitHub', category: 'engineering', status: 'available', auth: { kind: 'static_oauth' } },
  { type: 'google_slides', displayName: 'Google Slides', category: 'storage', status: 'available', auth: { kind: 'static_oauth' } },
]
vi.mock('../../hooks/useConnectorCatalog', () => ({
  useConnectorCatalog: () => ({
    connectors: CATALOG,
    byType: new Map(CATALOG.map(c => [c.type, c])),
    isLoading: false,
    labelForCategory: (k: string) => k,
  }),
}))

let mockConnectors: Connector[] = []
vi.mock('../../hooks/useConnectors', () => ({
  useConnectors: () => ({ data: mockConnectors, isPending: false }),
}))

let mockAgents: InternalAgent[] = []
vi.mock('../../hooks/useWorkforce', () => ({
  useWorkforce: () => ({
    data: {
      internalAgents: mockAgents,
      externalAgents: [],
      claudeCodeKeys: [],
      personnel: [],
    },
    isPending: false,
    error: null,
    refetch: vi.fn(),
  }),
  useInvalidateWorkforce: () => vi.fn(),
  WORKFORCE_QUERY_KEY: ['workforce'],
}))

function makeAgent(over: Partial<InternalAgent> & Pick<InternalAgent, 'id' | 'role'>): InternalAgent {
  return {
    responsibilities: 'Does the work',
    integrations: [],
    summary: 'A team',
    systemPrompt: null,
    userInstructions: null,
    temperature: 0.5,
    status: 'active',
    currentVersion: 1,
    tasksCompleted: 0,
    tasks30d: 0,
    monthlyCost: 0,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    lastActive: null,
    messagingNickname: null,
    lastActivity: null,
    lastActivityAction: null,
    workflowVisualizationSteps: null,
    autonomyOverride: null,
    aiVendorOverride: null,
    ...over,
  } as InternalAgent
}

function connector(id: string, type: string, status: Connector['status']): Connector {
  return {
    id,
    tenantId: 't1',
    type,
    name: type,
    status,
    config: {},
    lastSyncAt: null,
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
  } as Connector
}

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <AgentsPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  mockAgents = []
  mockConnectors = []
})

describe('AgentsPage binding health badge', () => {
  it('leaves a team with a live connector reading Active', () => {
    mockConnectors = [connector('c-gh', 'github', 'active')]
    mockAgents = [makeAgent({
      id: 'a1',
      role: 'Code Reviewer',
      integrations: [{ id: 'c-gh', integrationId: 'github', selectedObjects: [] }],
    })]

    renderPage()

    expect(screen.getAllByText('Active').length).toBeGreaterThan(0)
    expect(screen.queryByText('Error')).toBeNull()
  })

  it('renders Error and names the connection when the connector is gone', () => {
    mockAgents = [makeAgent({
      id: 'a1',
      role: 'Release Coordinator',
      integrations: [{ id: 'c-gone', integrationId: 'google_slides', selectedObjects: [] }],
    })]

    renderPage()

    expect(screen.getAllByText('Error').length).toBeGreaterThan(0)
    expect(
      screen.getAllByText('Google Slides is no longer connected. Connect it again to restore this agent.').length,
    ).toBeGreaterThan(0)
  })

  it('asks for a reconnect when the credential died', () => {
    mockConnectors = [connector('c-gh', 'github', 'error')]
    mockAgents = [makeAgent({
      id: 'a1',
      role: 'Code Reviewer',
      integrations: [{ id: 'c-gh', integrationId: 'github', selectedObjects: [] }],
    })]

    renderPage()

    expect(screen.getAllByText('Error').length).toBeGreaterThan(0)
    expect(
      screen.getAllByText('GitHub needs to be reconnected. Until then this agent cannot use it.').length,
    ).toBeGreaterThan(0)
  })

  // Health outranks lifecycle: a paused team with a dead connection still needs
  // that connection fixed, and Resume stays reachable from the row action.
  it('shows Error rather than Paused for a paused team with a broken binding', async () => {
    mockAgents = [makeAgent({
      id: 'a1',
      role: 'Customer Support Representative',
      status: 'paused',
      integrations: [{ id: 'c-gone', integrationId: 'google_slides', selectedObjects: [] }],
    })]

    renderPage()

    expect(screen.getAllByText('Error').length).toBeGreaterThan(0)
    expect(screen.queryByText('Paused')).toBeNull()

    // Nothing is hidden by that precedence: the paused state is still readable
    // from the row action, which offers Resume rather than Pause.
    await userEvent.click(screen.getAllByRole('button', { name: 'More options' })[0])
    expect(screen.getAllByRole('button', { name: /Resume Team/ }).length).toBeGreaterThan(0)
  })

  it('points the broken badge at the Connections page', () => {
    mockAgents = [makeAgent({
      id: 'a1',
      role: 'Release Coordinator',
      integrations: [{ id: 'c-gone', integrationId: 'google_slides', selectedObjects: [] }],
    })]

    renderPage()

    const links = screen.getAllByRole('link').filter(a => a.getAttribute('href') === '/dashboard/connections')
    expect(links.length).toBeGreaterThan(0)
  })

  // The stale-UUID rescue, end to end. A reconnect that minted a new connector
  // id must not light up every team that was bound to the old one.
  it('stays Active when the binding UUID is stale but the connector was reconnected', () => {
    mockConnectors = [connector('c-gh-new', 'github', 'active')]
    mockAgents = [makeAgent({
      id: 'a1',
      role: 'Code Reviewer',
      integrations: [{ id: 'c-gh-old', integrationId: 'github', selectedObjects: [] }],
    })]

    renderPage()

    expect(screen.getAllByText('Active').length).toBeGreaterThan(0)
    expect(screen.queryByText('Error')).toBeNull()
  })
})
