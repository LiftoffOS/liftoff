// The Save button's enabled state is the entire user-visible surface of the
// distill-handle change, and this page had no test file at all.
//
// Background: the page used to hold `systemPrompt`/`userInstructions` in state
// purely to carry the distiller's output from Optimize to Save, and both
// dirty-checks compared that text against the saved agent. Those fields no
// longer reach the client, so the comparison is now "is there an unsaved
// distillation", tracked by `pendingDistillId`.
//
// The sequence that matters is optimize-then-revert: distil, then undo the
// prose edit that triggered it. Every input field is back to its saved value
// while a regenerated prompt is still pending, so without the handle term the
// button would go disabled and the fresh summary and skills would be dropped on
// a save that never fired.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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
vi.mock('../../hooks/useTenant', () => ({
  useTenant: () => ({ currentTenant: { id: 'tenant-1' } }),
  useWorkspaceAiVendor: () => ({ data: undefined }),
  useWorkspaceAiVendorCatalog: () => ({ data: undefined }),
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

const saveButton = () => screen.getByRole('button', { name: /^save$/i })

describe('AgentUpdatePage save gating', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // clearAllMocks drops the implementation too, so the stream has to be
    // handed its completing behaviour back for each test.
    distillStream.mockImplementation(completeImmediately)
  })

  it('disables Save on a pristine load', () => {
    renderForm()
    expect(saveButton()).toBeDisabled()
  })

  it('enables Save once an input field changes', async () => {
    const user = userEvent.setup()
    renderForm()

    const roleInput = screen.getByDisplayValue('Support Engineer')
    await user.type(roleInput, ' II')

    expect(saveButton()).toBeEnabled()
  })

  it('sends distillId and no prompt fields when a save carries a distillation', async () => {
    const user = userEvent.setup()
    renderForm()

    const roleInput = screen.getByDisplayValue('Support Engineer')
    await user.type(roleInput, ' II')
    await user.click(saveButton())

    await waitFor(() => expect(updateMutate).toHaveBeenCalled())

    const payload = updateMutate.mock.calls[0][0].data
    expect(payload.distillId).toBe(DISTILL_ID)
    // The whole point: the compiled prompt is not the client's to send.
    expect(payload).not.toHaveProperty('systemPrompt')
    expect(payload).not.toHaveProperty('userInstructions')
    expect(payload).not.toHaveProperty('instructionsMd')
  })

  it('keeps Save enabled after an Optimize whose prose edit is then reverted', async () => {
    const user = userEvent.setup()
    renderForm()

    // Edit a primary field so Optimize appears, distil, then put the field back.
    const roleInput = screen.getByDisplayValue('Support Engineer')
    await user.type(roleInput, ' II')

    await user.click(screen.getByRole('button', { name: /advanced settings/i }))
    await user.click(screen.getByRole('button', { name: /optimize agent advanced settings/i }))
    await waitFor(() => expect(distillStream).toHaveBeenCalled())

    await user.clear(roleInput)
    await user.type(roleInput, 'Support Engineer')

    // Every input now matches the saved agent, but a regenerated prompt is
    // still unsaved. Before the handle term this went disabled and the
    // distillation was lost.
    expect(saveButton()).toBeEnabled()
  })

})
