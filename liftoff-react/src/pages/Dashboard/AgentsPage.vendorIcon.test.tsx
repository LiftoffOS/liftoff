// Coding-tool connections share one row kind on the Teams page. The row used
// to hardcode the Anthropic mark, so a Codex connection rendered the Claude
// logo; then it branded only 'openai', so every OAuth-connected tool
// (Gemini CLI, Grok, VS Code, Cursor, OpenCode, Codex over MCP) rendered as
// Claude Code. The row now brands itself from the vendor or client slug the
// workforce payload carries, and a client the backend does not know renders
// under the generic mark with its registered name.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router'
import AgentsPage from './AgentsPage'
import type { WorkforceClaudeCodeKey } from '../../hooks/useWorkforce'

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

// The two SVGs are imported through vite-plugin-svgr, which vitest does not
// transform here. Stub each to a testable marker so the assertion is about
// which mark the row picked, not about SVG internals.
vi.mock('../../assets/icons/claude.svg?react', () => ({
  default: () => <svg data-testid="claude-mark" />,
}))
vi.mock('../../assets/icons/openai.svg?react', () => ({
  default: () => <svg data-testid="openai-mark" />,
}))
vi.mock('../../assets/icons/opencode.svg?react', () => ({
  default: () => <svg data-testid="opencode-mark" />,
}))
vi.mock('../../assets/icons/gemini.svg?react', () => ({
  default: () => <svg data-testid="gemini-mark" />,
}))
vi.mock('../../assets/icons/grok.svg?react', () => ({
  default: () => <svg data-testid="grok-mark" />,
}))
vi.mock('../../assets/icons/vscode.svg?react', () => ({
  default: () => <svg data-testid="vscode-mark" />,
}))
vi.mock('../../assets/icons/cursor.svg?react', () => ({
  default: () => <svg data-testid="cursor-mark" />,
}))
vi.mock('../../assets/icons/plug.svg?react', () => ({
  default: () => <svg data-testid="plug-mark" />,
}))

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

let mockKeys: WorkforceClaudeCodeKey[] = []
vi.mock('../../hooks/useWorkforce', () => ({
  useWorkforce: () => ({
    data: {
      internalAgents: [],
      externalAgents: [],
      claudeCodeKeys: mockKeys,
      personnel: [],
    },
    isPending: false,
    error: null,
    refetch: vi.fn(),
  }),
  useInvalidateWorkforce: () => vi.fn(),
  WORKFORCE_QUERY_KEY: ['workforce'],
}))

const makeKey = (over: Partial<WorkforceClaudeCodeKey>): WorkforceClaudeCodeKey => ({
  id: 'key-1',
  tenantId: 't1',
  accountId: 'a1',
  keyPrefix: 'liftoff_sk_abcd1234',
  keyHint: 'wxyz',
  name: 'Connection',
  description: null,
  planType: null,
  costPerMonth: null,
  status: 'active',
  lastUsedAt: null,
  createdAt: new Date('2024-01-01').toISOString(),
  updatedAt: new Date('2024-01-01').toISOString(),
  keyType: 'developer_proxy',
  ...over,
})

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

describe('AgentsPage coding-agent row branding', () => {
  beforeEach(() => {
    mockKeys = []
  })

  it('renders the OpenAI mark for a Codex (openai vendor) connection', () => {
    mockKeys = [makeKey({ id: 'codex-1', name: 'Alex Rivera (Codex)', vendor: 'openai' })]

    renderPage()

    expect(screen.getAllByTestId('openai-mark').length).toBeGreaterThan(0)
    expect(screen.queryByTestId('claude-mark')).toBeNull()
    expect(screen.getAllByText('OpenAI Codex').length).toBeGreaterThan(0)
  })

  it('renders the Claude mark for an Anthropic vendor connection', () => {
    mockKeys = [makeKey({ id: 'cc-1', name: 'Jane Smith (Claude Code)', vendor: 'anthropic' })]

    renderPage()

    expect(screen.getAllByTestId('claude-mark').length).toBeGreaterThan(0)
    expect(screen.queryByTestId('openai-mark')).toBeNull()
  })

  it('falls back to the Claude mark when the payload carries no vendor', () => {
    // A platform-backend that predates the vendor field must not regress into
    // rendering the wrong mark; pre-vendor behavior was Claude Code for all.
    mockKeys = [makeKey({ id: 'legacy-1', name: 'Legacy key', vendor: undefined })]

    renderPage()

    expect(screen.getAllByTestId('claude-mark').length).toBeGreaterThan(0)
    expect(screen.queryByTestId('openai-mark')).toBeNull()
  })

  it('keeps the Claude mark on liftoff collab MCP tokens', () => {
    mockKeys = [makeKey({ id: 'mcp-1', name: 'Collab token', keyType: 'mcp', vendor: 'claude_code_mcp' })]

    renderPage()

    expect(screen.getAllByTestId('claude-mark').length).toBeGreaterThan(0)
    expect(screen.queryByTestId('openai-mark')).toBeNull()
  })

  it('brands each row independently when both vendors are connected', () => {
    mockKeys = [
      makeKey({ id: 'cc-1', name: 'Jane Smith (Claude Code)', vendor: 'anthropic' }),
      makeKey({ id: 'codex-1', name: 'Alex Rivera (Codex)', vendor: 'openai' }),
    ]

    renderPage()

    expect(screen.getAllByTestId('claude-mark').length).toBeGreaterThan(0)
    expect(screen.getAllByTestId('openai-mark').length).toBeGreaterThan(0)
  })

  describe('OAuth-connected tools', () => {
    const oauthKey = (vendor: string, clientLabel: string, clientName = clientLabel) =>
      makeKey({ id: `oauth-${vendor}`, keyType: 'mcp', vendor, clientName, clientLabel, name: `Jane Smith (${clientLabel})` })

    it.each([
      ['codex', 'Codex', 'openai-mark'],
      ['opencode', 'OpenCode', 'opencode-mark'],
      ['gemini-cli', 'Gemini CLI', 'gemini-mark'],
      ['grok', 'Grok', 'grok-mark'],
      ['vscode', 'VS Code', 'vscode-mark'],
      ['cursor', 'Cursor', 'cursor-mark'],
      ['claude-code', 'Claude Code', 'claude-mark'],
    ])('renders the %s mark with the label the backend named the row with', (vendor, label, testId) => {
      mockKeys = [oauthKey(vendor, label)]

      renderPage()

      expect(screen.getAllByTestId(testId).length).toBeGreaterThan(0)
      expect(screen.getAllByText(label).length).toBeGreaterThan(0)
      expect(screen.getAllByText(`Jane Smith (${label})`).length).toBeGreaterThan(0)
    })

    it('renders a client the backend does not know under the generic mark, named as it registered', () => {
      mockKeys = [oauthKey('mcp', 'Muse personal agent')]

      renderPage()

      expect(screen.getAllByTestId('plug-mark').length).toBeGreaterThan(0)
      expect(screen.queryByTestId('claude-mark')).toBeNull()
      expect(screen.getAllByText('Muse personal agent').length).toBeGreaterThan(0)
      expect(screen.getAllByText('Jane Smith (Muse personal agent)').length).toBeGreaterThan(0)
    })

    it('renders a tool without a mark of its own under the generic mark', () => {
      mockKeys = [oauthKey('windsurf', 'Windsurf')]

      renderPage()

      expect(screen.getAllByTestId('plug-mark').length).toBeGreaterThan(0)
      expect(screen.getAllByText('Windsurf').length).toBeGreaterThan(0)
    })
  })
})
