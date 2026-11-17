// The unread dot on /dashboard/agents. The page reads the counts once and hands
// each row a boolean, rather than every row asking the same tenant-wide
// question for itself. The dot sits on the Message Team button: it began as a
// badge on the action-menu item, and followed that action out to the button
// that replaced it.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import AgentsPage from './AgentsPage'
import type { InternalAgent } from '../../services/internalAgents'

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

let mockCounts: Record<string, number> = {}
vi.mock('../../hooks/useChatUnread', () => ({
  useChatUnreadCounts: () => ({ data: mockCounts }),
}))

let mockTeamPlanUnread = 0
vi.mock('../../hooks/useTeamPlanUnread', () => ({
  useTeamPlanUnreadCount: () => ({ data: mockTeamPlanUnread }),
}))

let mockTeams: InternalAgent[] = []
vi.mock('../../hooks/useWorkforce', () => ({
  useWorkforce: () => ({
    data: {
      internalAgents: mockTeams,
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
  mockCounts = {}
  mockTeams = []
  mockTeamPlanUnread = 0
})

describe('AgentsPage Message Team unread dot', () => {
  it('dots the Message Team button for a team with a non-zero count', () => {
    mockTeams = [makeTeam({ id: 'agent-unread', role: 'Sales Team' })]
    mockCounts = { 'agent-unread': 2 }

    renderPage()

    // Table and mobile cards both render; either button proves the wiring.
    const button = messageButtons('Sales Team')[0]
    expect(dotFor(button)).toBeInTheDocument()
    // The dot is not the only signal — the state rides the accessible name so
    // it reaches a screen reader and a colour-blind reader too.
    expect(button).toHaveAccessibleName('Message Sales Team, unread replies')
  })

  it('leaves the button undotted for a team with nothing unread', () => {
    mockTeams = [makeTeam({ id: 'agent-read', role: 'Sales Team' })]
    mockCounts = {}

    renderPage()

    const button = messageButtons('Sales Team')[0]
    expect(dotFor(button)).toBeNull()
    expect(button).toHaveAccessibleName('Message Sales Team')
  })

  it('dots only the team the count names', () => {
    mockTeams = [
      makeTeam({ id: 'agent-unread', role: 'Sales Team' }),
      makeTeam({ id: 'agent-read', role: 'Support Team' }),
    ]
    mockCounts = { 'agent-unread': 1 }

    renderPage()

    expect(dotFor(messageButtons('Sales Team')[0])).toBeInTheDocument()
    expect(dotFor(messageButtons('Support Team')[0])).toBeNull()
  })
})

/** Every Message Team button for a team, across the table and the mobile cards. */
function messageButtons(teamName: string) {
  return screen.getAllByRole('button', { name: new RegExp(`^Message ${teamName}`) })
}

/** The unread dot belonging to a Message Team button, or null when undotted. */
function dotFor(button: HTMLElement) {
  return button.parentElement?.querySelector('.agents-table__chat-btn-dot') ?? null
}

// The Chief AI Officer's own surface: the dot rides the Plan Workforce button
// in the header, from its own count (workforce-service migration 024), the
// same way each team's dot rides Message Team.
describe('AgentsPage Plan Workforce unread dot', () => {
  it('dots the button and augments the accessible name when replies are unread', () => {
    mockTeams = [makeTeam({ id: 'agent-1', role: 'Sales Team' })]
    mockTeamPlanUnread = 1

    renderPage()

    const button = screen.getByRole('button', { name: 'Plan Workforce, unread replies' })
    const dot = button.querySelector('.agents-page__icon-btn-dot')
    expect(dot).toBeInTheDocument()
    expect(dot).toHaveAttribute('aria-hidden', 'true')
  })

  it('shows no dot when nothing is unread', () => {
    mockTeams = [makeTeam({ id: 'agent-1', role: 'Sales Team' })]

    renderPage()

    const button = screen.getByRole('button', { name: 'Plan Workforce' })
    expect(button.querySelector('.agents-page__icon-btn-dot')).not.toBeInTheDocument()
  })

  it('keeps the team dots and the Plan Workforce dot independent', () => {
    // A team reply and a Chief AI Officer reply are different conversations;
    // one indicator must never light the other.
    mockTeams = [makeTeam({ id: 'agent-unread', role: 'Sales Team' })]
    mockCounts = { 'agent-unread': 1 }
    mockTeamPlanUnread = 0

    renderPage()

    expect(dotFor(messageButtons('Sales Team')[0])).toBeInTheDocument()
    const planButton = screen.getByRole('button', { name: 'Plan Workforce' })
    expect(planButton.querySelector('.agents-page__icon-btn-dot')).not.toBeInTheDocument()
  })
})
