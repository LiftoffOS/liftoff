// When the browser-notification banner appears, and when it must not.
//
// The rule it encodes: this IS the ask. Browser notifications cannot be turned
// on from the server, so a notice that waits for the account to opt in first
// can never be the thing that gets them enabled. It shows whenever this browser
// has not granted permission, including to somebody who has never opted in.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'

const mocks = vi.hoisted(() => ({
  permission: 'default' as string,
  dismissed: false,
  enable: vi.fn(),
  activeTeams: [{ id: 'a1' }] as { id: string }[],
}))

vi.mock('../../hooks/useInternalAgents', () => ({
  useInternalAgents: () => ({
    data: { pages: [{ internalAgents: mocks.activeTeams }] },
  }),
}))

vi.mock('../../lib/pushNotifications', () => ({
  getPushPermissionState: () => mocks.permission,
}))

vi.mock('../../hooks/useBrowserNotifications', () => ({
  useEnableBrowserNotifications: () => mocks.enable,
  useDisableBrowserNotifications: () => vi.fn(),
}))

vi.mock('../../lib/notificationPrompt', () => ({
  isPromptDismissed: () => mocks.dismissed,
  dismissPrompt: vi.fn(),
}))

vi.mock('../../lib/analytics', () => ({ track: vi.fn() }))

import { NotificationPermissionBanner } from './NotificationPermissionBanner'

function renderAt(path = '/dashboard') {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <NotificationPermissionBanner />
    </MemoryRouter>,
  )
}

describe('NotificationPermissionBanner', () => {
  beforeEach(() => {
    mocks.permission = 'default'
    mocks.dismissed = false
    mocks.activeTeams = [{ id: 'a1' }]
    mocks.enable.mockReset()
  })

  // The case the whole feature depends on: somebody who has never opted in and
  // has never been asked. Gating this behind the preference made the banner
  // unreachable for every existing account.
  it('asks an account that has never opted in', () => {
    renderAt('/dashboard')
    expect(screen.getByRole('alert').textContent).toContain('needs your permission')
    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy()
  })

  it('asks on the review queue, where waiting work makes the point', () => {
    renderAt('/dashboard/review')
    expect(screen.getByRole('alert').textContent).toContain('needs your permission')
  })

  // The Notification Delivery section there is the control; this is what says
  // the control is not currently doing anything, on the one page somebody opens
  // specifically to check.
  it('asks on the communication settings page', () => {
    renderAt('/dashboard/settings/communication')
    expect(screen.getByRole('alert').textContent).toContain('needs your permission')
  })

  it('does not ask on the other settings tabs', () => {
    renderAt('/dashboard/settings/profile')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // Nothing exists that could send a notification yet, so the ask is an
  // interruption attached to nothing — and it would spend the one permission
  // prompt the browser gives us at the worst possible moment.
  it('stays silent until the workspace has an active agent', () => {
    mocks.activeTeams = []
    renderAt('/dashboard')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('stays silent on the review queue too before any team is active', () => {
    mocks.activeTeams = []
    renderAt('/dashboard/review')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // A prefix match on '/dashboard' would swallow every route in the app.
  it('does not treat every dashboard route as the home page', () => {
    renderAt('/dashboard/connections')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // Denied is unrecoverable in-page: nothing can re-prompt once the browser has
  // stored a block, so offering Enable would be a button that cannot work.
  it('stops offering and starts explaining once the browser is blocking', () => {
    mocks.permission = 'denied'
    renderAt()
    expect(screen.getByRole('alert').textContent).toContain('blocking notifications')
    expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull()
    expect(screen.getByRole('button', { name: 'How To Fix' })).toBeTruthy()
  })

  it('renders nothing once permission has been granted', () => {
    mocks.permission = 'granted'
    renderAt()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // iOS Safari before install, or a build with no VAPID key. Neither can be
  // fixed from this page, so a notice would only interrupt.
  it('renders nothing when push is unavailable on this device', () => {
    mocks.permission = 'unavailable'
    renderAt()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('renders nothing when it was dismissed earlier in the session', () => {
    mocks.dismissed = true
    renderAt()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  // One notice per screen: the conversation asks in its own words and can name
  // the agent, so this stands down there rather than stacking.
  it('stands down on the chat route, which asks for itself', () => {
    renderAt('/dashboard/agents/chat')
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('carries a dismiss control, unlike the payment banner', () => {
    renderAt()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })

  // Enabling is permission AND the delivery preference. Granting alone leaves
  // the UI looking enabled while the backend sends nothing.
  it('routes Enable through the hook that does both writes', () => {
    mocks.enable.mockResolvedValue('granted')
    renderAt()
    screen.getByRole('button', { name: 'Enable' }).click()
    expect(mocks.enable).toHaveBeenCalledTimes(1)
  })
})
