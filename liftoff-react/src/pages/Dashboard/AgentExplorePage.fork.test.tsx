// What a rewritten template carries downstream.
//
// The component tests cover the editing itself. This covers the thing that is
// invisible until it is wrong: whether the words somebody typed actually reach
// the distiller and the create call, and whether the placeholders they left
// alone survive the trip. A fork honoured on screen but dropped on the wire
// produces a team built from the catalog's text while its owner reads their
// own — and nothing anywhere reports it.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'

const distillStream = vi.fn()
const describeTemplate = vi.fn<(...args: unknown[]) => Promise<{ description: string }>>()
vi.mock('../../services/internalAgents', async () => {
  const actual = await vi.importActual<typeof import('../../services/internalAgents')>(
    '../../services/internalAgents',
  )
  return {
    ...actual,
    distillInternalAgentStream: (...args: unknown[]) => distillStream(...args),
  }
})

const TEMPLATE = {
  id: 'accounts-payable-specialist',
  version: '2.0.1',
  schemaVersion: 1,
  displayName: 'Accounts Payable Specialist',
  departmentCategory: 'finance' as const,
  description: 'Owns the full AP cycle end-to-end.',
  role: 'Accounts Payable Specialist',
  roleSummary: '',
  responsibilities:
    '## Workflows\n1. Extract the vendor name and total amount\n'
    + '2. If no PO match: flag it and {{connector:opt-team-chat}} an alert',
  additionalContext: '## Rules\n- Never modify a previously paid bill',
  requiredConnectors: [],
  optionalConnectors: [{
    id: 'opt-team-chat',
    capability: 'team_chat',
    role: 'tool' as const,
    description: 'Team chat',
    requiredScopes: [],
    prose: { whenBound: 'post to {{pick:alert-channel}}', whenUnbound: 'email the approver' },
    objects: [{
      id: 'alert-channel',
      kind: 'channel' as const,
      direction: 'write' as const,
      required: false,
      label: 'Where alerts go',
      fallback: 'your finance channel',
    }],
  }],
  defaultAgentType: 'agent' as const,
  defaultMemoryScope: {},
  defaultTriggerConfig: { type: 'manual' as const },
  escalationPatterns: [],
}

vi.mock('../../services/agentTemplates', async () => {
  const actual = await vi.importActual<typeof import('../../services/agentTemplates')>(
    '../../services/agentTemplates',
  )
  return {
    ...actual,
    listAllAgentTemplates: () => Promise.resolve([TEMPLATE]),
    getAgentTemplate: () => Promise.resolve(TEMPLATE),
    describeEditedTemplate: (...args: unknown[]) => describeTemplate(...args),
  }
})

vi.mock('../../hooks/useTenant', () => ({
  useTenant: () => ({ currentTenant: { id: 'tenant-1' } }),
}))
vi.mock('../../hooks/useConnectors', () => ({ useConnectors: () => ({ data: [] }) }))
vi.mock('../../hooks/useConnectorCatalog', () => ({
  useConnectorCatalog: () => ({ connectors: [], byType: new Map() }),
}))
vi.mock('../../hooks/useIntegrations', () => ({
  useIntegrations: () => ({
    integrations: [], connected: [], pendingApproval: [], available: [], planned: [],
    isPending: false,
  }),
}))
vi.mock('../../hooks/useIntegrationConnect', () => ({
  useIntegrationConnect: () => ({ connect: vi.fn(), connecting: false }),
}))
vi.mock('../../hooks/useInternalAgents', () => ({ useCreateInternalAgent: () => ({ mutate: vi.fn() }) }))
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ showToast: vi.fn() }) }))
vi.mock('../../components/Dashboard/planGateContext', () => ({
  usePlanGate: () => ({ openIfPaymentRequired: () => false }),
}))

import AgentExplorePage from './AgentExplorePage'

function renderPage() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return render(
    <QueryClientProvider client={queryClient}>
      <MemoryRouter><AgentExplorePage /></MemoryRouter>
    </QueryClientProvider>,
  )
}

/** Gallery -> detail -> "What they do" open, which is where editing happens. */
async function openTemplate() {
  const view = renderPage()
  fireEvent.click(await screen.findByText('Accounts Payable Specialist'))
  fireEvent.click(await screen.findByRole('button', { name: /What they do/ }))
  // The prose arrives with the template fetch, and Continue is disabled until
  // it does — so every test starts from a fully loaded step.
  await screen.findAllByLabelText('Rewrite this section')
  return view
}

/** Rewrite a line, the way the editor hands it up. */
async function rewriteFirstLine(container: HTMLElement, text: string) {
  fireEvent.mouseDown((await screen.findAllByLabelText('Rewrite this section'))[0])
  const editor = container.querySelector('.inline-prose--editing') as HTMLElement
  editor.querySelectorAll('.inline-prose__line')[0].textContent = text
  fireEvent.blur(editor)
}

/** The input the distiller was handed. */
function distillInput() {
  return distillStream.mock.calls[0][1] as {
    role: string; responsibilities: string; additionalContext: string
  }
}

beforeEach(() => {
  distillStream.mockReset()
  describeTemplate.mockReset()
  // Never settles by default: the line under the role name stays as it is
  // unless a test says otherwise.
  describeTemplate.mockImplementation(() => new Promise<{ description: string }>(() => {}))
})

describe('a rewritten template on the wire', () => {
  it('sends the catalog text untouched when nothing was edited', async () => {
    await openTemplate()
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(distillStream).toHaveBeenCalled())
    expect(distillInput().responsibilities).toBe(TEMPLATE.responsibilities)
    expect(distillInput().role).toBe(TEMPLATE.role)
  })

  it('sends the rewritten line instead of the template one', async () => {
    const { container } = await openTemplate()
    await rewriteFirstLine(container, 'Extract the vendor name, total and due date')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(distillStream).toHaveBeenCalled())
    expect(distillInput().responsibilities).toContain('Extract the vendor name, total and due date')
    expect(distillInput().responsibilities).not.toContain('Extract the vendor name and total amount')
  })

  it('keeps the placeholder on a line nobody touched', async () => {
    // The whole field is re-serialised when one line changes, so an untouched
    // line has to come back through the round trip with its token intact — or
    // the hire silently targets a generic phrase instead of their channel.
    const { container } = await openTemplate()
    await rewriteFirstLine(container, 'Extract the vendor name only')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(distillStream).toHaveBeenCalled())
    expect(distillInput().responsibilities).toContain('{{connector:opt-team-chat}}')
  })

  it('keeps the heading structure the template was written with', async () => {
    const { container } = await openTemplate()
    await rewriteFirstLine(container, 'Extract the vendor name only')
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(distillStream).toHaveBeenCalled())
    expect(distillInput().responsibilities).toContain('## Workflows')
  })

  it('sends the renamed role, and leaves the untouched prose alone', async () => {
    await openTemplate()
    const name = screen.getByLabelText('Rename this team')
    fireEvent.focus(name)
    name.textContent = 'Vendor Invoice Handler'
    fireEvent.blur(name)

    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(distillStream).toHaveBeenCalled())
    expect(distillInput().role).toBe('Vendor Invoice Handler')
    expect(distillInput().responsibilities).toBe(TEMPLATE.responsibilities)
  })
})

describe('leaving the detail step', () => {
  it('goes straight back to the gallery when nothing was rewritten', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(true)
    await openTemplate()
    fireEvent.click(screen.getByRole('button', { name: /Back/i }))
    expect(confirm).not.toHaveBeenCalled()
    confirm.mockRestore()
  })

  it('asks first when there are rewritten lines to lose', async () => {
    const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)
    const { container } = await openTemplate()
    await rewriteFirstLine(container, 'Extract the vendor name only')
    fireEvent.click(screen.getByRole('button', { name: /Back/i }))
    expect(confirm).toHaveBeenCalled()
    // Refused, so the edit is still here.
    expect(screen.getByLabelText('Rename this team')).toBeInTheDocument()
    confirm.mockRestore()
  })
})

describe('the description while the team is being rewritten', () => {
  it('goes to a skeleton rather than standing there describing the old team', async () => {
    const { container } = await openTemplate()
    expect(screen.getByText(TEMPLATE.description)).toBeInTheDocument()
    await rewriteFirstLine(container, 'Extract the vendor name only')
    await waitFor(() =>
      expect(container.querySelector('.explore-detail__description--pending')).not.toBeNull())
    expect(screen.queryByText(TEMPLATE.description)).toBeNull()
  })

  it('keeps rewriting through a long editing session', async () => {
    // A person rewriting a template commits far more than a handful of edits.
    // A per-visit ceiling that silently returns leaves the ORIGINAL catalog
    // description on screen for the rest of the visit, with nothing to say the
    // feature has stopped — which reads as the rewrite simply not working.
    describeTemplate.mockImplementation(() =>
      Promise.resolve({ description: `Rewrite ${describeTemplate.mock.calls.length}` }))
    const { container } = await openTemplate()

    for (let i = 0; i < 25; i++) {
      await rewriteFirstLine(container, `Extract the vendor name, pass ${i}`)
    }
    // Counting the calls, not reading the line: once a ceiling stops the
    // rewrites the line holds the LAST one, which still looks like a rewrite.
    // That is exactly why the freeze was invisible.
    expect(describeTemplate).toHaveBeenCalledTimes(25)
  })

  it('shows the rewritten line once it lands', async () => {
    describeTemplate.mockResolvedValue({ description: 'Handles AP on your own rules.' })
    const { container } = await openTemplate()
    await rewriteFirstLine(container, 'Extract the vendor name only')
    expect(await screen.findByText('Handles AP on your own rules.')).toBeInTheDocument()
  })

  it('keeps the catalog line when the route is not deployed', async () => {
    // Until the platform-backend route ships this 404s everywhere. Stripping a
    // description off every edited template in the meantime would be a worse
    // regression than leaving the one that was already there.
    const { ApiError } = await import('../../services/api')
    describeTemplate.mockRejectedValue(new ApiError('Not Found', 404))
    const { container } = await openTemplate()
    await rewriteFirstLine(container, 'Extract the vendor name only')
    expect(await screen.findByText(TEMPLATE.description)).toBeInTheDocument()
  })

  it('keeps the line it had when rate limited, rather than blanking it', async () => {
    // A 429 is "ask again shortly", not "this description is wrong". Blanking
    // on it would let a momentary limit cost somebody their description for the
    // rest of the visit.
    const { ApiError } = await import('../../services/api')
    describeTemplate.mockRejectedValue(new ApiError('Too many', 429))
    const { container } = await openTemplate()
    await rewriteFirstLine(container, 'Extract the vendor name only')
    expect(await screen.findByText(TEMPLATE.description)).toBeInTheDocument()
    expect(container.querySelector('.explore-detail__description--pending')).toBeNull()
  })

  it('says so, in the same slot, when the route is there and fails', async () => {
    // Three wrong answers were available here. The catalog's sentence now
    // describes a team that does not exist. Nothing at all pulls the sections
    // upward and explains none of it. And the skeleton left running promises
    // something is arriving that never will.
    const { ApiError } = await import('../../services/api')
    describeTemplate.mockRejectedValue(new ApiError('Boom', 500))
    const { container } = await openTemplate()
    await rewriteFirstLine(container, 'Extract the vendor name only')

    expect(await screen.findByText('This description could not be updated')).toBeInTheDocument()
    expect(screen.queryByText(TEMPLATE.description)).toBeNull()
    expect(container.querySelector('.explore-detail__description--pending')).toBeNull()
  })
})
