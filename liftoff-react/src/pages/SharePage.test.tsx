import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router'

const mockNavigate = vi.fn()
vi.mock('react-router', async () => {
  const actual = await vi.importActual('react-router')
  return { ...actual, useNavigate: () => mockNavigate }
})

const mockSwitchTenant = vi.fn()
const mockRefreshTenants = vi.fn()
let mockTenant: {
  currentTenant: { id: string } | null
  tenants: Array<{ id: string }>
  tenantLoading: boolean
  switchTenant: typeof mockSwitchTenant
  refreshTenants: typeof mockRefreshTenants
}
vi.mock('../hooks/useTenant', () => ({ useTenant: () => mockTenant }))

const mockResolveChatShare = vi.fn()
vi.mock('../services/agentChat', () => ({
  resolveChatShare: (...args: unknown[]) => mockResolveChatShare(...args),
}))
vi.mock('../lib/analytics', () => ({ track: vi.fn() }))

import SharePage from './SharePage'

const SHARE_ID = '66666666-6666-6666-6666-666666666666'
const AGENT_ID = 'agent-1'
const THREAD_ID = 'thread-1'
// Navigation uses router state so internal ids never reach the URL bar.
const CHAT_NAV = ['/dashboard/agents/chat', { state: { agentId: AGENT_ID, threadId: THREAD_ID }, replace: true }] as const
// The three surfaces that are not a team's own chat carry the thread alone.
const THREAD_ONLY = { state: { threadId: THREAD_ID }, replace: true } as const
const ERROR_TITLE = 'This link could not be opened'

function renderAt(shareId: string) {
  return render(
    <MemoryRouter initialEntries={[`/share/${shareId}`]}>
      <Routes>
        <Route path="/share/:shareId" element={<SharePage />} />
      </Routes>
    </MemoryRouter>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  mockTenant = {
    currentTenant: { id: 'tenant-a' },
    tenants: [{ id: 'tenant-a' }],
    tenantLoading: false,
    switchTenant: mockSwitchTenant,
    refreshTenants: mockRefreshTenants,
  }
  mockRefreshTenants.mockResolvedValue(undefined)
  mockResolveChatShare.mockResolvedValue({
    tenantId: 'tenant-a',
    agentId: AGENT_ID,
    threadId: THREAD_ID,
  })
})

describe('SharePage', () => {
  it('navigates straight to the chat when the share is in the active workspace', async () => {
    renderAt(SHARE_ID)
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(...CHAT_NAV)
    })
    expect(mockResolveChatShare).toHaveBeenCalledWith(SHARE_ID)
    expect(mockSwitchTenant).not.toHaveBeenCalled()
    expect(mockRefreshTenants).not.toHaveBeenCalled()
  })

  it('switches workspace first and navigates only after the switch takes effect', async () => {
    mockResolveChatShare.mockResolvedValue({
      tenantId: 'tenant-b',
      agentId: AGENT_ID,
      threadId: THREAD_ID,
    })
    mockTenant.tenants = [{ id: 'tenant-a' }, { id: 'tenant-b' }]

    const { rerender } = renderAt(SHARE_ID)
    await waitFor(() => {
      expect(mockSwitchTenant).toHaveBeenCalledWith('tenant-b')
    })
    expect(mockNavigate).not.toHaveBeenCalled()

    // Simulate the context state update switchTenant would make.
    mockTenant.currentTenant = { id: 'tenant-b' }
    rerender(
      <MemoryRouter initialEntries={[`/share/${SHARE_ID}`]}>
        <Routes>
          <Route path="/share/:shareId" element={<SharePage />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(...CHAT_NAV)
    })
  })

  it('refreshes the tenant list once when the workspace is missing, then switches', async () => {
    mockResolveChatShare.mockResolvedValue({
      tenantId: 'tenant-b',
      agentId: AGENT_ID,
      threadId: THREAD_ID,
    })
    // Like the real AuthContext, the refresh updates the tenant list before
    // it resolves; the component re-reads it on its refreshDone re-render.
    mockRefreshTenants.mockImplementation(async () => {
      mockTenant.tenants = [{ id: 'tenant-a' }, { id: 'tenant-b' }]
    })

    const { rerender } = renderAt(SHARE_ID)
    await waitFor(() => {
      expect(mockRefreshTenants).toHaveBeenCalledTimes(1)
    })
    await waitFor(() => {
      expect(mockSwitchTenant).toHaveBeenCalledWith('tenant-b')
    })
    expect(mockNavigate).not.toHaveBeenCalled()

    mockTenant.currentTenant = { id: 'tenant-b' }
    rerender(
      <MemoryRouter initialEntries={[`/share/${SHARE_ID}`]}>
        <Routes>
          <Route path="/share/:shareId" element={<SharePage />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(...CHAT_NAV)
    })
  })

  it('shows the error state when the refresh completes without finding the workspace', async () => {
    // The swallowed-failure path: refreshTenants resolves but no context
    // state changes (AuthContext catches fetch errors internally). The
    // page's local refreshDone state must still route to the error UI
    // instead of spinning forever.
    mockResolveChatShare.mockResolvedValue({
      tenantId: 'tenant-b',
      agentId: AGENT_ID,
      threadId: THREAD_ID,
    })

    renderAt(SHARE_ID)
    await waitFor(() => {
      expect(screen.getByText(ERROR_TITLE)).toBeInTheDocument()
    })
    expect(mockRefreshTenants).toHaveBeenCalledTimes(1)
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('waits for the tenant list before resolving', async () => {
    mockTenant.tenantLoading = true

    const { rerender } = renderAt(SHARE_ID)
    expect(mockResolveChatShare).not.toHaveBeenCalled()

    mockTenant.tenantLoading = false
    rerender(
      <MemoryRouter initialEntries={[`/share/${SHARE_ID}`]}>
        <Routes>
          <Route path="/share/:shareId" element={<SharePage />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(...CHAT_NAV)
    })
  })

  it('opens a plan share on the plan page, with no team in the state', async () => {
    mockResolveChatShare.mockResolvedValue({
      tenantId: 'tenant-a',
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      threadKind: 'team_plan',
    })

    renderAt(SHARE_ID)
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/dashboard/agents/plan', THREAD_ONLY)
    })
  })

  // The two surfaces with no team behind them: the backend omits agentId, and
  // the resolver must not put one in the state it hands over either.
  it('opens an insights share on the insights page', async () => {
    mockResolveChatShare.mockResolvedValue({
      tenantId: 'tenant-a',
      threadId: THREAD_ID,
      threadKind: 'insights',
    })

    renderAt(SHARE_ID)
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/dashboard/insights', THREAD_ONLY)
    })
  })

  it('opens a Liftoff share on the Liftoff page', async () => {
    mockResolveChatShare.mockResolvedValue({
      tenantId: 'tenant-a',
      threadId: THREAD_ID,
      threadKind: 'liftoff',
    })

    renderAt(SHARE_ID)
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/dashboard/liftoff', THREAD_ONLY)
    })
  })

  it('switches workspace first for a share on a surface with no team', async () => {
    mockResolveChatShare.mockResolvedValue({
      tenantId: 'tenant-b',
      threadId: THREAD_ID,
      threadKind: 'liftoff',
    })
    mockTenant.tenants = [{ id: 'tenant-a' }, { id: 'tenant-b' }]

    const { rerender } = renderAt(SHARE_ID)
    await waitFor(() => {
      expect(mockSwitchTenant).toHaveBeenCalledWith('tenant-b')
    })
    expect(mockNavigate).not.toHaveBeenCalled()

    mockTenant.currentTenant = { id: 'tenant-b' }
    rerender(
      <MemoryRouter initialEntries={[`/share/${SHARE_ID}`]}>
        <Routes>
          <Route path="/share/:shareId" element={<SharePage />} />
        </Routes>
      </MemoryRouter>,
    )
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith('/dashboard/liftoff', THREAD_ONLY)
    })
  })

  // Links minted before threadKind existed carry no kind at all. They are all
  // agent chats and must keep opening as one.
  it('treats a share with no kind as a team chat', async () => {
    renderAt(SHARE_ID)
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(...CHAT_NAV)
    })
  })

  it('opens an explicit agent share on the team chat', async () => {
    mockResolveChatShare.mockResolvedValue({
      tenantId: 'tenant-a',
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      threadKind: 'agent',
    })

    renderAt(SHARE_ID)
    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith(...CHAT_NAV)
    })
  })

  it('shows the error state when the share cannot be resolved', async () => {
    mockResolveChatShare.mockRejectedValue(new Error('HTTP 404'))

    renderAt(SHARE_ID)
    await waitFor(() => {
      expect(screen.getByText(ERROR_TITLE)).toBeInTheDocument()
    })
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})
