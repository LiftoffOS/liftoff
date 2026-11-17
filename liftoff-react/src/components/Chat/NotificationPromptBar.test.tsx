// Does the chat offer actually render?
//
// There was no test for this component, only for the dashboard banner, and the
// gap showed: every gate open in a real browser (permission 'default', nothing
// dismissed, no pending approval) and no element in the DOM.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  permission: 'default' as string,
  dismissed: false,
  enable: vi.fn(),
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

import { NotificationPromptBar } from './NotificationPromptBar'

function renderBar() {
  return render(<NotificationPromptBar replierName="Atlas" onOpenHelp={vi.fn()} />)
}

describe('NotificationPromptBar', () => {
  beforeEach(() => {
    mocks.permission = 'default'
    mocks.dismissed = false
    mocks.enable.mockReset()
  })

  it('renders the offer when this browser has not been asked', () => {
    renderBar()
    expect(screen.getByRole('status')).toBeTruthy()
    expect(screen.getByText(/Get notified when Atlas replies/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Enable' })).toBeTruthy()
  })

  it('carries the class the page styles it with', () => {
    const { container } = renderBar()
    expect(container.querySelector('.chat-page__notification-prompt')).toBeTruthy()
  })

  it('explains rather than offers once the browser is blocking', () => {
    mocks.permission = 'denied'
    renderBar()
    expect(screen.getByText(/blocking notifications from Liftoff/)).toBeTruthy()
    expect(screen.getByRole('button', { name: 'How To Fix' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Enable' })).toBeNull()
  })

  it('renders nothing once permission is granted', () => {
    mocks.permission = 'granted'
    const { container } = renderBar()
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing where push does not exist', () => {
    mocks.permission = 'unavailable'
    const { container } = renderBar()
    expect(container.firstChild).toBeNull()
  })

  it('renders nothing when dismissed earlier in the session', () => {
    mocks.dismissed = true
    const { container } = renderBar()
    expect(container.firstChild).toBeNull()
  })

  // The team plan heading is "Plan", the artifact rather than the thing that
  // replies, so surfaces without a speaker to name say so instead of inventing
  // one.
  it('names no speaker when the surface has none', () => {
    render(<NotificationPromptBar onOpenHelp={vi.fn()} />)
    expect(screen.getByText('Get notified when a reply arrives')).toBeTruthy()
  })

  it('offers a dismiss control', () => {
    renderBar()
    expect(screen.getByRole('button', { name: 'Dismiss' })).toBeTruthy()
  })
})
