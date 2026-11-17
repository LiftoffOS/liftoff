// getPushPermissionState — the resolver every push surface reads.
//
// All four states matter and three of them are easy to get wrong.
// `unavailable` in particular is not a fallback: it is what iOS Safari looks
// like before the site is installed, and what a build with no VAPID key looks
// like. Both must render nothing rather than an Enable button that cannot work.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({ vapidKey: 'test-vapid-key' }))

vi.mock('../config/firebase', () => ({
  app: {},
  get vapidKey() {
    return mocks.vapidKey
  },
}))

vi.mock('../services/pushSubscriptions', () => ({
  registerPushSubscription: vi.fn(),
  deletePushSubscription: vi.fn(),
}))

const originalNotification = globalThis.Notification
const originalServiceWorker = navigator.serviceWorker

function setNotification(permission: NotificationPermission | null) {
  if (permission === null) {
    // @ts-expect-error deliberately removing the global to model iOS Safari
    delete globalThis.Notification
    return
  }
  Object.defineProperty(globalThis, 'Notification', {
    value: { permission, requestPermission: vi.fn() },
    configurable: true,
    writable: true,
  })
}

function setPushSupport(supported: boolean) {
  if (supported) {
    Object.defineProperty(globalThis, 'PushManager', { value: function () {}, configurable: true })
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { register: vi.fn(), getRegistration: vi.fn(), getRegistrations: vi.fn() },
      configurable: true,
    })
    return
  }
  // @ts-expect-error modelling a browser with no Push API
  delete globalThis.PushManager
}

describe('getPushPermissionState', () => {
  beforeEach(() => {
    vi.resetModules()
    mocks.vapidKey = 'test-vapid-key'
    setPushSupport(true)
  })

  afterEach(() => {
    Object.defineProperty(globalThis, 'Notification', {
      value: originalNotification,
      configurable: true,
      writable: true,
    })
    Object.defineProperty(navigator, 'serviceWorker', {
      value: originalServiceWorker,
      configurable: true,
    })
  })

  it('reports granted when the browser has already allowed notifications', async () => {
    setNotification('granted')
    const { getPushPermissionState } = await import('./pushNotifications')
    expect(getPushPermissionState()).toBe('granted')
  })

  it('reports denied when the browser is blocking', async () => {
    setNotification('denied')
    const { getPushPermissionState } = await import('./pushNotifications')
    expect(getPushPermissionState()).toBe('denied')
  })

  it('reports default when nobody has been asked yet', async () => {
    setNotification('default')
    const { getPushPermissionState } = await import('./pushNotifications')
    expect(getPushPermissionState()).toBe('default')
  })

  // iOS Safari before the site is installed to the Home Screen. The API is not
  // restricted there, it is absent, so touching Notification.permission would
  // throw rather than answer.
  it('reports unavailable when the Notification API does not exist', async () => {
    setNotification(null)
    const { getPushPermissionState } = await import('./pushNotifications')
    expect(getPushPermissionState()).toBe('unavailable')
  })

  it('reports unavailable when the browser has no Push API', async () => {
    setNotification('default')
    setPushSupport(false)
    const { getPushPermissionState } = await import('./pushNotifications')
    expect(getPushPermissionState()).toBe('unavailable')
  })

  // A build with no VAPID key can request permission and then fail at getToken,
  // which is worse than not offering: the person grants access and gets nothing.
  it('reports unavailable when the build carries no VAPID key', async () => {
    setNotification('default')
    mocks.vapidKey = ''
    const { getPushPermissionState } = await import('./pushNotifications')
    expect(getPushPermissionState()).toBe('unavailable')
  })
})
