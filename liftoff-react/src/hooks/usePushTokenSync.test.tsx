// Watching this browser's push registration for as long as the app is open.
//
// The bug this closes is silent by construction: Firebase reissues a device's
// identifier, the server keeps sending to the stale one and FCM keeps reporting
// success, and the person stops receiving notifications with nothing to see. So
// the rules are worth pinning: watch when it is wanted and allowed, never
// prompt, and let go when the layout does.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook } from '@testing-library/react'

const mocks = vi.hoisted(() => ({
  permission: 'granted' as string,
  browser: true as boolean | undefined,
  sync: vi.fn(),
}))

vi.mock('../lib/pushNotifications', () => ({
  getPushPermissionState: () => mocks.permission,
  syncPushRegistration: mocks.sync,
}))

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    account: { preferences: { notificationDelivery: { browser: mocks.browser } } },
  }),
}))

import { usePushTokenSync } from './usePushTokenSync'

describe('usePushTokenSync', () => {
  beforeEach(() => {
    mocks.permission = 'granted'
    mocks.browser = true
    mocks.sync.mockReset()
    mocks.sync.mockResolvedValue(undefined)
  })

  it('watches and repairs the registration when it is wanted and already permitted', () => {
    renderHook(() => usePushTokenSync())
    expect(mocks.sync).toHaveBeenCalledTimes(1)
  })

  it('does nothing for an account that has not asked for browser notifications', () => {
    mocks.browser = undefined
    renderHook(() => usePushTokenSync())
    expect(mocks.sync).not.toHaveBeenCalled()
  })

  // The whole point is that it is silent. Running on 'default' would raise a
  // browser permission dialog on page load, which is the pattern the entire
  // design exists to avoid.
  it('never runs before permission has been granted', () => {
    mocks.permission = 'default'
    renderHook(() => usePushTokenSync())
    expect(mocks.sync).not.toHaveBeenCalled()
  })

  it('does not run when the browser is blocking', () => {
    mocks.permission = 'denied'
    renderHook(() => usePushTokenSync())
    expect(mocks.sync).not.toHaveBeenCalled()
  })

  it('does not run where push does not exist', () => {
    mocks.permission = 'unavailable'
    renderHook(() => usePushTokenSync())
    expect(mocks.sync).not.toHaveBeenCalled()
  })

  // Once per session, not once per render: the layout re-renders constantly and
  // each run is a service-worker registration plus an FCM round trip.
  it('runs once across re-renders', () => {
    const { rerender } = renderHook(() => usePushTokenSync())
    rerender()
    rerender()
    expect(mocks.sync).toHaveBeenCalledTimes(1)
  })

  // The listener is installed once per page and deliberately outlives this
  // component: releasing it on unmount would drop exactly the late, unprompted
  // events it exists to catch.
  it('does not tear anything down when the layout goes away', () => {
    const { unmount } = renderHook(() => usePushTokenSync())
    expect(() => unmount()).not.toThrow()
    expect(mocks.sync).toHaveBeenCalledTimes(1)
  })
})
