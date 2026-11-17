// The role rule on /dashboard/agents. Team update, status and archive are
// member and above (D1); a viewer sees the teams and no action menu at all.
// PermissionGate('edit_teams') wraps every ActionMenu on the page, and the
// backend enforces the same rule inside the shared workspace actions, so the
// gate hides only what the server would refuse.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
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

let mockRole: 'owner' | 'admin' | 'member' | 'viewer' = 'member'
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ canManageMembers: true, currentRole: mockRole, currentTenant: { id: 't1', name: 'T' } }),
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


beforeEach(() => {
  mockTeams = []
  mockExternalAgents = []
  mockRole = 'member'
  mockNavigate.mockClear()
})

describe('AgentsPage action menus and the role rule', () => {
  it('a member sees the action menu on a team row', () => {
    mockTeams = [makeTeam({ id: 'agent-1', role: 'Sales Team' })]
    renderPage()
    expect(screen.getAllByRole('button', { name: 'More options' }).length).toBeGreaterThan(0)
  })

  it('a viewer sees the team and no action menu', () => {
    mockRole = 'viewer'
    mockTeams = [makeTeam({ id: 'agent-1', role: 'Sales Team' })]
    mockExternalAgents = [makeExternalAgent({ id: 'ext-9', name: 'Partner Bot' })]
    renderPage()
    expect(screen.getAllByText('Sales Team').length).toBeGreaterThan(0)
    expect(screen.queryAllByRole('button', { name: 'More options' })).toHaveLength(0)
  })
})
