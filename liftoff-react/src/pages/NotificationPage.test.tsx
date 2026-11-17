// Where an opaque notification link actually lands.
//
// The link table gained a surface column because three of the four chat
// surfaces could not be linked to at all, so a notification from Liftoff,
// Insights or the team plan had nowhere to send anybody. Routing them all to
// agent chat would have been the same bug with a worse symptom: a page that
// loads and shows the wrong conversation.

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

const mockResolve = vi.fn()
vi.mock('../services/notificationLinks', () => ({
  resolveNotificationLink: (...args: unknown[]) => mockResolve(...args),
}))
const mockTrack = vi.fn()
vi.mock('../lib/analytics', () => ({ track: (...args: unknown[]) => mockTrack(...args) }))

import NotificationPage from './NotificationPage'

const LINK_ID = '66666666-6666-6666-6666-666666666666'
const AGENT_ID = 'agent-1'
const THREAD_ID = 'thread-1'
// Navigation uses router state so internal ids never reach the URL bar.
const THREAD_ONLY = { state: { threadId: THREAD_ID }, replace: true } as const
const ERROR_TITLE = 'This notification could not be opened'

function renderPage() {
  return render(
    <MemoryRouter initialEntries={[`/notification/${LINK_ID}`]}>
      <Routes>
        <Route path="/notification/:notificationId" element={<NotificationPage />} />
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
})

describe('NotificationPage', () => {
  it('opens an agent chat link with both the team and the thread', async () => {
    mockResolve.mockResolvedValue({
      tenantId: 'tenant-a',
      destination: 'chat',
      surface: 'agent',
      agentId: AGENT_ID,
      threadId: THREAD_ID,
      recordId: null,
    })
    renderPage()
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('/dashboard/agents/chat', {
        state: { agentId: AGENT_ID, threadId: THREAD_ID },
        replace: true,
      }),
    )
  })

  it.each([
    ['liftoff', '/dashboard/liftoff'],
    ['insights', '/dashboard/insights'],
    ['team_plan', '/dashboard/agents/plan'],
  ])('opens a %s link on its own page', async (surface, route) => {
    mockResolve.mockResolvedValue({
      tenantId: 'tenant-a',
      destination: 'chat',
      surface,
      threadId: THREAD_ID,
      recordId: null,
    })
    renderPage()
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith(route, THREAD_ONLY))
  })

  it('opens a review link on the review queue', async () => {
    mockResolve.mockResolvedValue({ tenantId: 'tenant-a', destination: 'review', recordId: 'esc-1' })
    renderPage()
    await waitFor(() =>
      expect(mockNavigate).toHaveBeenCalledWith('/dashboard/review', { replace: true }),
    )
  })

  // The URL is the only public artifact. Whatever else changes, no id may reach
  // the address bar.
  it('never puts an id in the path it navigates to', async () => {
    mockResolve.mockResolvedValue({
      tenantId: 'tenant-a',
      destination: 'chat',
      surface: 'liftoff',
      threadId: THREAD_ID,
      recordId: null,
    })
    renderPage()
    await waitFor(() => expect(mockNavigate).toHaveBeenCalled())
    expect(mockNavigate.mock.calls[0][0]).not.toContain(THREAD_ID)
  })

  // Click-through has to be measurable per surface: three of them were dead
  // until now, and "nobody clicks Insights notifications" and "Insights
  // notifications go nowhere" look identical without this.
  it('reports which surface was opened', async () => {
    mockResolve.mockResolvedValue({
      tenantId: 'tenant-a',
      destination: 'chat',
      surface: 'insights',
      threadId: THREAD_ID,
      recordId: null,
    })
    renderPage()
    await waitFor(() =>
      expect(mockTrack).toHaveBeenCalledWith('notification_link_opened', {
        destination: 'chat',
        surface: 'insights',
      }),
    )
  })

  // Switching workspace first, exactly as SharePage does: navigating before the
  // switch lands opens the destination in the wrong tenant.
  it('activates the link workspace before navigating', async () => {
    mockTenant.currentTenant = { id: 'tenant-b' }
    mockTenant.tenants = [{ id: 'tenant-a' }, { id: 'tenant-b' }]
    mockResolve.mockResolvedValue({
      tenantId: 'tenant-a',
      destination: 'chat',
      surface: 'liftoff',
      threadId: THREAD_ID,
      recordId: null,
    })
    renderPage()
    await waitFor(() => expect(mockSwitchTenant).toHaveBeenCalledWith('tenant-a'))
    expect(mockNavigate).not.toHaveBeenCalled()
  })

  it('shows one failure state for anything that will not resolve', async () => {
    mockResolve.mockRejectedValue(new Error('404'))
    renderPage()
    expect(await screen.findByText(ERROR_TITLE)).toBeInTheDocument()
    expect(mockNavigate).not.toHaveBeenCalled()
  })
})
