// "Inspect Team" on /dashboard/agents. It sends the user to the Activity feed
// already narrowed to the team they picked, and it does so through router state
// rather than the URL: the address must stay a bare /dashboard/activity, with
// no team id and no query string in it.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import AgentsPage from './AgentsPage'
import type { InternalAgent } from '../../services/internalAgents'
import type { ExternalAgent } from '../../services/externalAgents'

class ResizeObserverMock {
  observe = vi.fn()
  unobserve = vi.fn()
  disconnect = vi.fn()
}
global.ResizeObserver = ResizeObserverMock

const { mockNavigate } = vi.hoisted(() => ({ mockNavigate: vi.fn() }))
vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router')
  return { ...actual, useNavigate: () => mockNavigate }
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
vi.mock('../../hooks/useChatUnread', () => ({
  useChatUnreadCounts: () => ({ data: {} }),
}))

let mockTeams: InternalAgent[] = []
let mockExternalAgents: ExternalAgent[] = []
vi.mock('../../hooks/useWorkforce', () => ({
  useWorkforce: () => ({
    data: {
      internalAgents: mockTeams,
      externalAgents: mockExternalAgents,
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

function makeTeam(over: Partial<InternalAgent> & { id: string; role: string }): InternalAgent {
  return {
    tenantId: 't1',
    status: 'active',
    summary: 'Does the thing',
    responsibilities: 'Does the thing',
    integrations: [],
    tasks30d: 0,
    monthlyCost: 0,
    lastActivity: null,
    lastActivityAction: null,
    createdAt: new Date('2026-01-01').toISOString(),
    updatedAt: new Date('2026-01-01').toISOString(),
    ...over,
  } as unknown as InternalAgent
}

function makeExternalAgent(over: Partial<ExternalAgent> & { id: string; name: string }): ExternalAgent {
  return {
    tenantId: 't1',
    status: 'connected',
    description: 'A partner system',
    summary: 'A partner system',
    allowedInternalAgentIds: [],
    tasks30d: 0,
    monthlyCost: 0,
    lastActivity: null,
    lastActivityAction: null,
    createdAt: new Date('2026-01-01').toISOString(),
    ...over,
  } as unknown as ExternalAgent
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

/** Opens the first action menu on the page and returns its item labels. */
async function openFirstMenu() {
  const user = userEvent.setup()
  const trigger = screen.getAllByRole('button', { name: 'More options' })[0]
  await user.click(trigger)
  // The menu root, not the trigger's parent: the trigger sits inside its
  // tooltip wrapper, and the dropdown is a sibling of that wrapper.
  const menu = trigger.closest('.action-menu') as HTMLElement
  return {
    user,
    menu,
    labels: Array.from(menu.querySelectorAll('.action-menu__item-label')).map(el => el.textContent),
  }
}

beforeEach(() => {
  mockTeams = []
  mockExternalAgents = []
  mockNavigate.mockClear()
})

describe('AgentsPage "Inspect Team"', () => {
  it('sits between the pause action and Archive Team', async () => {
    mockTeams = [makeTeam({ id: 'agent-1', role: 'Sales Team' })]

    renderPage()
    const { labels } = await openFirstMenu()

    expect(labels).toEqual(['Update Team', 'Pause Team', 'Inspect Team', 'Archive Team'])
  })

  it('routes an agent to the Activity page, carrying its name in router state', async () => {
    mockTeams = [makeTeam({ id: 'agent-1', role: 'Sales Team' })]

    renderPage()
    const { user, menu } = await openFirstMenu()
    await user.click(within(menu).getByRole('button', { name: 'Inspect Team' }))

    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/activity', {
      state: { teamSearch: 'Sales Team' },
    })
  })

  it('routes an external agent by its own name', async () => {
    mockExternalAgents = [makeExternalAgent({ id: 'ext-9', name: 'Partner Bot' })]

    renderPage()
    const { user, menu } = await openFirstMenu()
    await user.click(within(menu).getByRole('button', { name: 'Inspect Team' }))

    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/activity', {
      state: { teamSearch: 'Partner Bot' },
    })
  })

  it('puts nothing identifying in the path it navigates to', async () => {
    mockTeams = [makeTeam({ id: 'agent-1', role: 'Sales Team' })]

    renderPage()
    const { user, menu } = await openFirstMenu()
    await user.click(within(menu).getByRole('button', { name: 'Inspect Team' }))

    const [path] = mockNavigate.mock.calls[0]
    expect(path).toBe('/dashboard/activity')
    expect(path).not.toContain('?')
    expect(path).not.toContain('agent-1')
  })
})
