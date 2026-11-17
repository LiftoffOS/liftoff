// Tests for the build route shell.
//
// This page used to do two jobs: custom hire, and editing an explore template
// seeded from `state.templateId`. The second is gone with the Edit button on
// the template detail step, which now edits its own prose in place. What is
// guarded here is that it stayed gone — a template id arriving in history
// state must not revive a fetch, because the seed it fed the builder flattened
// every `{{pick:...}}` to its generic fallback on the way through.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'

const navigate = vi.fn()
vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router')
  return { ...actual, useNavigate: () => navigate }
})

const getAgentTemplate = vi.fn()
vi.mock('../../services/agentTemplates', async () => {
  const actual = await vi.importActual<typeof import('../../services/agentTemplates')>(
    '../../services/agentTemplates',
  )
  return { ...actual, getAgentTemplate: (id: string) => getAgentTemplate(id) }
})

// Stubbed so the assertions read what the shell hands down, rather than
// re-testing the wizard itself.
vi.mock('./AgentBuilder/AgentBuilder', () => ({
  default: (props: Record<string, unknown>) => (
    <div data-testid="builder" data-props={Object.keys(props).sort().join(',')} />
  ),
}))

import AgentBuildPage from './AgentBuildPage'

function renderAt(state?: Record<string, unknown>) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter initialEntries={[{ pathname: '/dashboard/agents/build', ...(state ? { state } : {}) }]}>
        <AgentBuildPage />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  getAgentTemplate.mockReset()
  navigate.mockReset()
})

describe('AgentBuildPage', () => {
  it('renders the custom-hire builder and fetches nothing', () => {
    renderAt()
    expect(screen.getByTestId('builder')).toBeInTheDocument()
    expect(getAgentTemplate).not.toHaveBeenCalled()
  })

  it('hands the builder no template seed', () => {
    renderAt()
    // Only the two navigation callbacks. `initialTemplate` reaching the builder
    // again would mean the template-edit detour is back.
    expect(screen.getByTestId('builder').dataset.props).toBe('onCancel,onComplete')
  })

  it('ignores a template id left in history state', () => {
    // An old link, a back button, or a stale tab can still carry one. It must
    // not revive the fetch or the seed.
    renderAt({ templateId: 'support-triage-v1' })
    expect(getAgentTemplate).not.toHaveBeenCalled()
    expect(screen.getByTestId('builder').dataset.props).toBe('onCancel,onComplete')
  })
})
