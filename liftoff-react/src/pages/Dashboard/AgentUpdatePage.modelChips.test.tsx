// The AI Provider Override card on a team shows the chosen provider's models
// and coding tool under its dropdown, as the Workspace AI card does in
// Settings: only once the card is open, following the dropdown before a save,
// and never for Liftoff Managed.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import { InternalTeamForm } from './AgentUpdatePage'
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

// Save sits behind PermissionGate (edit_teams: member and above), which
// reads the role from the auth context.
vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ currentRole: 'member', currentTenant: { id: 't1', name: 'T' } }),
}))
vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}))
vi.mock('../../lib/analytics', () => ({ track: vi.fn() }))

const DISTILL_ID = '33333333-3333-4333-8333-333333333333'
const updateMutate = vi.fn()

// Optimize and Save both run the streamed distillation now, behind the
// progress modal, so the seam is the service rather than a mutation hook.
// Completing synchronously keeps these tests about save gating, which is what
// they are for; LoadingStep.test.tsx covers the progress reporting itself.
type StreamCallbacks = { onComplete: (result: unknown) => void }
const distillStream = vi.fn((..._args: unknown[]): Promise<void> => Promise.resolve())

/** Completes the moment it is called: these tests are about save gating. */
const completeImmediately = (...args: unknown[]) => {
  const callbacks = args[2] as StreamCallbacks
  callbacks.onComplete({
    agentType: 'agent',
    distillId: DISTILL_ID,
    summary: 'Regenerated summary.',
    skills: [],
  })
  return Promise.resolve()
}

vi.mock('../../services/internalAgents', async () => {
  const actual = await vi.importActual('../../services/internalAgents')
  return {
    ...actual,
    distillInternalAgentStream: (...args: unknown[]) => distillStream(...args),
  }
})

vi.mock('../../hooks/useInternalAgents', () => ({
  useInternalAgent: () => ({ data: undefined, isPending: false }),
  useInternalAgents: () => ({ data: { pages: [] } }),
  useUpdateInternalAgent: () => ({ mutate: updateMutate, isPending: false }),
  useRecordInternalAgentView: () => ({ mutate: vi.fn() }),
  useInternalAgentVersions: () => ({ data: { versions: [] } }),
  useAgentMemories: () => ({ data: { memories: [] } }),
  useAgentSkills: () => ({ data: { skills: [] } }),
  useAgentWebhook: () => ({ data: undefined }),
}))
vi.mock('../../hooks/useKnowledge', () => ({ useKnowledgeItems: () => ({ data: [] }) }))
vi.mock('../../hooks/useIntegrations', () => ({
  useIntegrations: () => ({ connected: [], available: [] }),
}))
vi.mock('../../hooks/useOversight', () => ({
  useOversightSettings: () => ({ data: undefined }),
}))
// The workspace runs on Anthropic. The catalog read reports whether the card
// asked for it, so the test can hold it to "only once the card is open".
const CATALOG = {
  models: {
    anthropic: ['Claude Fable 5.1', 'Claude Opus 5.5', 'Claude Sonnet 5', 'Claude Haiku 4.5'],
    qwen: ['Qwen 3.8 Max', 'Qwen 3.7 Plus', 'Qwen 3.7 Flash'],
  },
  coding: {
    anthropic: { tool: 'Claude Code' },
    qwen: { tool: 'OpenCode', model: 'Qwen 3.8 Max' },
  },
}
const catalogRequested = vi.fn()
vi.mock('../../hooks/useTenant', () => ({
  useTenant: () => ({ currentTenant: { id: 'tenant-1' } }),
  useWorkspaceAiVendor: () => ({ data: 'anthropic' }),
  useWorkspaceAiVendorCatalog: (_tenantId: string | undefined, enabled: boolean) => {
    catalogRequested(enabled)
    return { data: enabled ? CATALOG : undefined }
  },
}))
vi.mock('../../hooks/useDeptSlug', () => ({ useDeptSlug: () => 'engineering' }))
vi.mock('../../hooks/useConnectorCatalog', () => ({
  useConnectorCatalog: () => ({ connectors: [], byType: {} }),
}))

const team: InternalAgent = {
  id: 'agent-1',
  role: 'Support Engineer',
  responsibilities: 'Answer inbound tickets.',
  integrations: [],
  additionalContext: 'Escalate billing questions.',
  summary: 'Handles support.',
  temperature: 0.3,
  status: 'active',
  currentVersion: 2,
  tasksCompleted: 0,
  tasks30d: 0,
  monthlyCost: 0,
  createdAt: new Date(0).toISOString(),
  updatedAt: new Date(0).toISOString(),
  lastActive: null,
} as unknown as InternalAgent

function renderForm() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <InternalTeamForm team={team} onSave={vi.fn()} onCancel={vi.fn()} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}


function chips(group: 'Models' | 'Coding') {
  const list = screen.queryByRole('list', { name: group })
  return list ? within(list).getAllByRole('listitem').map((li) => li.textContent) : []
}

async function openProviderCard(user: ReturnType<typeof userEvent.setup>) {
  await user.click(screen.getByRole('button', { name: /AI Provider Override/ }))
}

describe('the AI Provider Override model chips', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    distillStream.mockImplementation(completeImmediately)
    // jsdom has no scrollIntoView; the Dropdown calls it on the focused option.
    Element.prototype.scrollIntoView = vi.fn()
  })

  it('are not shown, or read, while the card is closed', () => {
    renderForm()
    expect(chips('Models')).toEqual([])
    expect(catalogRequested.mock.calls.every(([enabled]) => enabled === false)).toBe(true)
  })

  it('show the inherited workspace provider once the card opens', async () => {
    const user = userEvent.setup()
    renderForm()
    await openProviderCard(user)
    expect(chips('Models')).toEqual(['Claude Fable 5.1', 'Claude Opus 5.5', 'Claude Sonnet 5', 'Claude Haiku 4.5'])
    expect(chips('Coding')).toEqual(['Claude Code'])
  })

  it('follow an override chosen in the dropdown, and show none for Liftoff Managed', async () => {
    const user = userEvent.setup()
    renderForm()
    await openProviderCard(user)
    await user.click(screen.getByRole('button', { name: /^Anthropic/ }))
    await user.click(screen.getByRole('option', { name: /^Qwen/ }))
    expect(chips('Models')).toEqual(['Qwen 3.8 Max', 'Qwen 3.7 Plus', 'Qwen 3.7 Flash'])
    expect(chips('Coding')).toEqual(['OpenCode', 'Qwen 3.8 Max'])
    await user.click(screen.getByRole('button', { name: /^Qwen/ }))
    await user.click(screen.getByRole('option', { name: /^Liftoff Managed/ }))
    expect(chips('Models')).toEqual([])
    expect(chips('Coding')).toEqual([])
  })
})
