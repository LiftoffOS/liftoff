// A requirement is what the template asks for; a family is what the person
// connects. The comparison writer asks for a documents app twice, once for the
// folder it writes into and once for the document it argues from, and the
// backend keeps those two questions on two requirements on purpose. The card
// and the detail chips are not where either question is asked, so there the
// two read as one "Documents" and not as a stutter.

import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'

const TEMPLATE = {
  id: 'competitor-comparison-writer',
  version: '1.1.1',
  schemaVersion: 1,
  displayName: 'Competitor Comparison Writer',
  departmentCategory: 'marketing' as const,
  description: 'Drafts comparison pages.',
  role: 'Competitor Comparison Writer',
  roleSummary: '',
  responsibilities: '## Workflows\n1. Research the competitor',
  additionalContext: '## Rules\n- Cite every claim',
  requiredConnectors: [
    { id: 'req-documents', capability: 'documents', role: 'tool' as const, requiredScopes: [], description: 'Where they save drafts' },
    { id: 'req-positioning', capability: 'documents', role: 'data_source' as const, requiredScopes: [], description: 'What they argue from' },
  ],
  optionalConnectors: [
    { id: 'opt-data-table', capability: 'data_table', role: 'tool' as const, requiredScopes: [], description: 'The backlog' },
  ],
  defaultAgentType: 'agent' as const,
  defaultMemoryScope: {},
  defaultTriggerConfig: { type: 'manual' as const },
  escalationPatterns: [],
}

const CATALOG = [
  { type: 'google_docs', displayName: 'Google Docs', caps: ['documents'] },
  { type: 'notion', displayName: 'Notion', caps: ['documents', 'data_table'] },
  { type: 'airtable', displayName: 'Airtable', caps: ['data_table'] },
].map(c => ({
  type: c.type, displayName: c.displayName, category: 'productivity', status: 'available' as const,
  auth: { kind: 'oauth' }, capabilities: c.caps.map(capability => ({ capability, requiredScopes: [] })),
}))

vi.mock('../../services/agentTemplates', async () => {
  const actual = await vi.importActual<typeof import('../../services/agentTemplates')>('../../services/agentTemplates')
  return {
    ...actual,
    listAllAgentTemplates: () => Promise.resolve([TEMPLATE]),
    getAgentTemplate: () => Promise.resolve(TEMPLATE),
    describeEditedTemplate: () => Promise.resolve({ description: '' }),
  }
})
vi.mock('../../hooks/useTenant', () => ({ useTenant: () => ({ currentTenant: { id: 'tenant-1' } }) }))
vi.mock('../../hooks/useConnectors', () => ({ useConnectors: () => ({ data: [] }) }))
vi.mock('../../hooks/useConnectorCatalog', () => ({
  useConnectorCatalog: () => ({ connectors: CATALOG, byType: new Map(CATALOG.map(c => [c.type, c])) }),
}))
vi.mock('../../hooks/useIntegrations', () => ({
  useIntegrations: () => ({
    integrations: [], connected: [], pendingApproval: [], available: [], planned: [], isPending: false,
  }),
}))
vi.mock('../../hooks/useIntegrationConnect', () => ({
  useIntegrationConnect: () => ({ connect: vi.fn(), connecting: false, installTargetModal: null }),
}))
vi.mock('../../hooks/useInternalAgents', () => ({ useCreateInternalAgent: () => ({ mutate: vi.fn() }) }))
vi.mock('../../contexts/ToastContext', () => ({ useToast: () => ({ showToast: vi.fn() }) }))
vi.mock('../../components/Dashboard/planGateContext', () => ({ usePlanGate: () => ({ openIfPaymentRequired: () => false }) }))

import AgentExplorePage from './AgentExplorePage'

function renderPage() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter><AgentExplorePage /></MemoryRouter>
    </QueryClientProvider>,
  )
}

describe('two requirements on one family', () => {
  it('the gallery card shows the family once', async () => {
    const { container } = renderPage()
    await screen.findByText('Competitor Comparison Writer')
    const footer = container.querySelector('.template-card__footer') as HTMLElement
    expect(footer.querySelectorAll('.capability-icon-stack')).toHaveLength(1)
    expect(footer.querySelector('.template-card__connector-more')).toBeNull()
  })

  it('the detail step lists one Documents chip under Required', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('Competitor Comparison Writer'))
    await screen.findByText('What should they work with?')
    expect(screen.getAllByText('Documents')).toHaveLength(1)
    expect(screen.getAllByText('Data Table')).toHaveLength(1)
  })

  it('the connectors step still asks both questions', async () => {
    renderPage()
    fireEvent.click(await screen.findByText('Competitor Comparison Writer'))
    // Continue is disabled until the template body has loaded.
    const cont = await screen.findByRole('button', { name: 'Continue' })
    await waitFor(() => expect(cont).toBeEnabled())
    fireEvent.click(cont)
    await screen.findByText('What they work with')
    expect(screen.getByText('Where they save drafts')).toBeInTheDocument()
    expect(screen.getByText('What they argue from')).toBeInTheDocument()
  })
})
