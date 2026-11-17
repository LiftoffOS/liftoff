// Backing out of the distillation loading screen.
//
// The loading screen was the one step of the wizard with no way back, and it
// is the step with by far the longest wait. Adding the button is the easy
// half. The half that matters is that leaving actually abandons the run: the
// stream drives `setStep`, so a distillation still talking to a wizard that
// walked away pulls someone off step 3, mid-edit, onto a confirmation screen
// for a team they stopped asking for.
//
// These tests hold that the button aborts, that the abandoned run cannot move
// the wizard afterwards, and that leaving is not reported as a failure.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import type { DistillStreamCallbacks } from '../../../services/internalAgents'

vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router')
  return { ...actual, useNavigate: () => vi.fn() }
})

vi.mock('../../../hooks/useTenant', () => ({
  useTenant: () => ({ currentTenant: { id: 'test-tenant-id' } }),
}))

vi.mock('../../../hooks/useInternalAgents', () => ({
  useCreateInternalAgent: () => ({ mutate: vi.fn(), isPending: false }),
  useInternalAgents: () => ({ data: { pages: [{ internalAgents: [] }] } }),
}))

vi.mock('../../../hooks/useKnowledge', () => ({
  useKnowledgeItems: () => ({ data: [] }),
}))

vi.mock('../../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}))

const distillInternalAgentStream = vi.fn()
vi.mock('../../../services/internalAgents', () => ({
  distillInternalAgentStream: (...args: unknown[]) => distillInternalAgentStream(...args),
}))

const track = vi.fn()
vi.mock('../../../lib/analytics', () => ({ track: (...args: unknown[]) => track(...args) }))

// TipTap needs a real layout engine; none of this is about how text is edited.
vi.mock('../../../components/ResponsibilitiesInput', () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="responsibilities" value={value} onChange={e => onChange(e.target.value)} />
  ),
  stripTemplateIfUntouched: (v: string) => v,
}))

vi.mock('../../../components/AdditionalGuidanceInput', () => ({
  default: ({ value, onChange }: { value: string; onChange: (v: string) => void }) => (
    <textarea aria-label="guidance" value={value} onChange={e => onChange(e.target.value)} />
  ),
}))

vi.mock('./steps/IntegrationsStep', () => ({
  default: ({ onContinue }: { onContinue: () => void }) => (
    <button type="button" onClick={onContinue}>Continue</button>
  ),
}))

import AgentBuilder from './AgentBuilder'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>
        <MemoryRouter>{children}</MemoryRouter>
      </QueryClientProvider>
    )
  }
}

/** Render seeded past step 1, then walk to the loading screen. */
function renderAtLoadingStep() {
  const utils = render(<AgentBuilder initialRole="Recruiter" />, { wrapper: createWrapper() })
  // Seeded past step 1 by initialRole; the responsibilities step gates its
  // Continue on having something to distill.
  fireEvent.change(screen.getByLabelText('responsibilities'), {
    target: { value: 'Screen inbound applicants and book first-round calls.' },
  })
  fireEvent.click(screen.getByRole('button', { name: /continue/i }))
  fireEvent.click(screen.getByRole('button', { name: /continue/i }))

  const call = distillInternalAgentStream.mock.calls[0]
  return {
    ...utils,
    callbacks: call[2] as DistillStreamCallbacks,
    signal: call[3] as AbortSignal,
    back: () => fireEvent.click(screen.getByRole('button', { name: /go back/i })),
  }
}

beforeEach(() => {
  distillInternalAgentStream.mockClear()
  track.mockClear()
})

describe('cancelling a running distillation', () => {
  it('offers a way back from the loading screen', () => {
    renderAtLoadingStep()

    expect(screen.getByText('On it.')).toBeInTheDocument()
    // The regression: `showBackButton = step !== 4` hid it on exactly this step.
    expect(screen.getByRole('button', { name: /go back/i })).toBeInTheDocument()
  })

  it('aborts the stream and returns to the connectors step', () => {
    const { signal, back } = renderAtLoadingStep()
    expect(signal.aborted).toBe(false)

    back()

    expect(signal.aborted).toBe(true)
    expect(screen.queryByText('On it.')).not.toBeInTheDocument()
  })

  it('cannot be dragged forward by the run it walked away from', () => {
    const { callbacks, back } = renderAtLoadingStep()
    back()

    // The stream does not stop mid-sentence just because the reader was
    // released: whatever was already in flight still calls back.
    act(() => {
      callbacks.onSummaryReady?.('A recruiter who screens inbound applicants.')
      callbacks.onComplete({ summary: 'x', agentType: 'internal', distillId: 'd1' } as never)
    })

    // Still on the connectors step (its stub renders Continue), not yanked
    // onto the confirmation screen for a team they stopped asking for.
    expect(screen.queryByText(/is ready\./i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /continue/i })).toBeInTheDocument()
  })

  it('does not report walking away as a failure', () => {
    const { callbacks, back } = renderAtLoadingStep()
    back()

    act(() => callbacks.onError({ message: 'The user aborted a request.' }))

    expect(screen.queryByText('Something went wrong')).not.toBeInTheDocument()
    expect(track).not.toHaveBeenCalledWith('team_builder_distill_failed', expect.anything())
  })

  it('records the cancel with the stage it had reached', () => {
    const { callbacks, back } = renderAtLoadingStep()
    act(() => callbacks.onProgress('generating'))

    back()

    expect(track).toHaveBeenCalledWith('team_builder_distill_canceled', { stage: 'generating' })
  })

  it('abandons the run when the wizard unmounts entirely', () => {
    const { signal, unmount } = renderAtLoadingStep()

    unmount()

    expect(signal.aborted).toBe(true)
  })
})
