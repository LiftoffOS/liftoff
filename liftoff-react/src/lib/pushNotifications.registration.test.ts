// The FCM registration path.
//
// This code had no test at all: pushNotifications.test.ts only ever exercised
// getPushPermissionState(), which returns before any dynamic import. Everything
// that actually talks to FCM — the permission prompt, the FID subscription, the
// legacy-token handover, the unregister — was unverified, and the FID migration
// rewrote every line of it.
//
// The properties pinned here are the ones whose failure is SILENT: a device that
// registers and is never recorded, a device recorded twice, and a device turned
// off in Settings that keeps receiving.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const mocks = vi.hoisted(() => ({
  vapidKey: 'test-vapid-key',
  register: vi.fn(),
  unregister: vi.fn(),
  getId: vi.fn(),
  onRegistered: vi.fn(),
  onUnregistered: vi.fn(),
  registerSubscription: vi.fn(),
  deleteSubscription: vi.fn(),
  swRegistration: { scope: '/' } as unknown,
}))

vi.mock('../config/firebase', () => ({
  app: {},
  get vapidKey() {
    return mocks.vapidKey
  },
}))

vi.mock('../services/pushSubscriptions', () => ({
  registerPushSubscription: (...a: unknown[]) => mocks.registerSubscription(...a),
  deletePushSubscription: (...a: unknown[]) => mocks.deleteSubscription(...a),
}))

vi.mock('firebase/installations', () => ({
  getInstallations: () => ({}),
  getId: (...a: unknown[]) => mocks.getId(...a),
}))

vi.mock('firebase/messaging', () => ({
  getMessaging: () => ({}),
  register: (...a: unknown[]) => mocks.register(...a),
  unregister: (...a: unknown[]) => mocks.unregister(...a),
  onRegistered: (...a: unknown[]) => mocks.onRegistered(...a),
  onUnregistered: (...a: unknown[]) => mocks.onUnregistered(...a),
}))

const originalNotification = globalThis.Notification
const originalServiceWorker = navigator.serviceWorker

const FID = 'installation-id-abc'

/** Hand the FID to whatever `onRegistered` callback was installed. */
function emitRegistered(fid = FID) {
  const calls = mocks.onRegistered.mock.calls
  const cb = calls[calls.length - 1]?.[1] as ((f: string) => void) | undefined
  cb?.(fid)
}

function emitUnregistered(fid = FID) {
  const calls = mocks.onUnregistered.mock.calls
  const cb = calls[calls.length - 1]?.[1] as ((f: string) => void) | undefined
  cb?.(fid)
}

/** Let the module's internal awaits settle.
 *
 * Macrotasks, not microtasks: ensureRegistrationWatch awaits a dynamic
 * `import('firebase/messaging')`, which does not resolve within a microtask
 * drain however many times you flush it. */
async function settle() {
  for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 0))
}

function setPermission(permission: NotificationPermission, requested = permission) {
  Object.defineProperty(globalThis, 'Notification', {
    value: { permission, requestPermission: vi.fn().mockResolvedValue(requested) },
    configurable: true,
    writable: true,
  })
}

beforeEach(() => {
  vi.resetModules()
  vi.clearAllMocks()
  mocks.vapidKey = 'test-vapid-key'
  mocks.register.mockResolvedValue(undefined)
  mocks.unregister.mockResolvedValue(undefined)
  mocks.getId.mockResolvedValue(FID)
  mocks.onRegistered.mockReturnValue(vi.fn())
  mocks.onUnregistered.mockReturnValue(vi.fn())
  mocks.registerSubscription.mockResolvedValue({ id: 'sub-1' })
  mocks.deleteSubscription.mockResolvedValue(undefined)

  Object.defineProperty(globalThis, 'PushManager', { value: function () {}, configurable: true })
  Object.defineProperty(navigator, 'serviceWorker', {
    value: {
      register: vi.fn().mockResolvedValue(mocks.swRegistration),
      getRegistration: vi.fn().mockResolvedValue(mocks.swRegistration),
      getRegistrations: vi.fn().mockResolvedValue([]),
    },
    configurable: true,
  })
  setPermission('granted')
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

describe('requestAndRegister', () => {
  it('prompts, then registers this device with the vapid key and our worker', async () => {
    const { requestAndRegister } = await import('./pushNotifications')

    expect(await requestAndRegister()).toBe('granted')
    expect(mocks.register).toHaveBeenCalledTimes(1)
    expect(mocks.register.mock.calls[0][1]).toMatchObject({
      vapidKey: 'test-vapid-key',
      serviceWorkerRegistration: mocks.swRegistration,
    })
  })

  // A dismissal reports 'default', not 'denied'. Neither is an error and
  // neither should register anything.
  it.each([
    ['denied', 'denied'],
    ['default', 'default'],
  ])('registers nothing when the prompt comes back %s', async (answer, expected) => {
    setPermission('default', answer as NotificationPermission)
    const { requestAndRegister } = await import('./pushNotifications')

    expect(await requestAndRegister()).toBe(expected)
    expect(mocks.register).not.toHaveBeenCalled()
  })

  // A build with no VAPID key can prompt and then fail to register, which is
  // worse than not offering: the person grants access and gets nothing.
  it('does not prompt at all without a vapid key', async () => {
    mocks.vapidKey = ''
    const { requestAndRegister } = await import('./pushNotifications')

    expect(await requestAndRegister()).toBe('unavailable')
    expect(mocks.register).not.toHaveBeenCalled()
  })
})

describe('ensureRegistrationWatch', () => {
  it('records every FID this device is issued', async () => {
    const { ensureRegistrationWatch } = await import('./pushNotifications')
    await ensureRegistrationWatch()
    await settle()

    emitRegistered()
    await settle()

    expect(mocks.registerSubscription).toHaveBeenCalledWith(FID)
  })

  // The whole reason for moving off getToken(). A rotation arrives here with no
  // click behind it, long after any button was pressed.
  it('records a rotated FID with no user action', async () => {
    const { ensureRegistrationWatch } = await import('./pushNotifications')
    await ensureRegistrationWatch()
    await settle()

    emitRegistered('first-fid')
    await settle()
    emitRegistered('rotated-fid')
    await settle()

    expect(mocks.registerSubscription).toHaveBeenNthCalledWith(1, 'first-fid')
    // No legacy token the second time. getToken() MINTS one when the device has
    // none, so repeating the handover would manufacture a legacy registration
    // for a device that never had one and keep it alive forever. There is also
    // nothing left to hand over: the first call retired the old row.
    expect(mocks.registerSubscription).toHaveBeenNthCalledWith(2, 'rotated-fid')
  })

  // Watching is not registering: this installs listeners and nothing else, so
  // it can run on page load without side effects.
  it('does not register anything by itself', async () => {
    const { ensureRegistrationWatch } = await import('./pushNotifications')
    await ensureRegistrationWatch()
    await settle()

    expect(mocks.register).not.toHaveBeenCalled()
  })

  // Idempotent: two callers both need the listener installed, and installing it
  // twice would record every device twice.
  it('installs the listeners only once however many callers ask', async () => {
    const { ensureRegistrationWatch } = await import('./pushNotifications')
    await ensureRegistrationWatch()
    await ensureRegistrationWatch()
    await settle()

    expect(mocks.onRegistered).toHaveBeenCalledTimes(1)
    expect(mocks.onUnregistered).toHaveBeenCalledTimes(1)
  })

  // FCM telling us the device can no longer receive. Leaving the row would make
  // every future send look successful while reaching nobody.
  it('retires a device FCM reports as unregistered', async () => {
    const { ensureRegistrationWatch } = await import('./pushNotifications')
    await ensureRegistrationWatch()
    await settle()

    emitUnregistered()
    await settle()

    expect(mocks.deleteSubscription).toHaveBeenCalledWith(FID)
  })

  // A browser with no Push API must not register a service worker or reach FCM.
  it('does nothing where push does not exist', async () => {
    // @ts-expect-error modelling a browser with no Push API
    delete globalThis.PushManager
    const { ensureRegistrationWatch } = await import('./pushNotifications')
    await ensureRegistrationWatch()
    await settle()

    expect(mocks.onRegistered).not.toHaveBeenCalled()
    expect(mocks.register).not.toHaveBeenCalled()
  })
})

describe('unregisterPush', () => {
  // This DELETE is also what clears notificationDelivery.browser server-side.
  // Skipping it leaves the preference advertising a channel with nothing behind
  // it, which is a state Settings cannot show and nothing repairs.
  it('tells the backend before clearing local state', async () => {
    const mod = await import('./pushNotifications')
    await mod.ensureRegistrationWatch()
    await settle()
    emitRegistered()
    await settle()

    mocks.deleteSubscription.mockClear()
    await mod.unregisterPush()

    expect(mocks.deleteSubscription).toHaveBeenCalledWith(FID)
    expect(mocks.unregister).toHaveBeenCalledTimes(1)
  })

  // Turning off twice is not a real flow, but it must be safe: the backend
  // answers 204 either way. What must NOT happen is a single disable being
  // doubled by the unregister echo, which the guards below cover.
  it('is safe to call twice', async () => {
    const mod = await import('./pushNotifications')
    await mod.ensureRegistrationWatch()
    await settle()
    emitRegistered()
    await settle()

    await expect(mod.unregisterPush()).resolves.toBeUndefined()
    await expect(mod.unregisterPush()).resolves.toBeUndefined()
  })

  it('does nothing when this browser never registered a worker', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      value: {
        register: vi.fn(),
        getRegistration: vi.fn().mockResolvedValue(undefined),
        getRegistrations: vi.fn(),
      },
      configurable: true,
    })
    const { unregisterPush } = await import('./pushNotifications')
    await unregisterPush()

    expect(mocks.unregister).not.toHaveBeenCalled()
    expect(mocks.deleteSubscription).not.toHaveBeenCalled()
  })
})

// The ordering contract, on both paths that trigger a registration.
//
// register() delivers its FID through onRegistered and NOWHERE else, so
// registering before the listener exists loses it silently and the device is
// never recorded. On the enable path that is fatal rather than untidy: it is a
// first-time enable, so the app-scope watch has not started yet — the account
// does not want browser notifications until this very flow succeeds.
describe('listener ordering', () => {
  function recordOrder() {
    const order: string[] = []
    mocks.onRegistered.mockImplementation(() => {
      order.push('subscribed')
      return vi.fn()
    })
    mocks.register.mockImplementation(async () => {
      order.push('registered')
    })
    return order
  }

  it('subscribes before registering when enabling for the first time', async () => {
    const order = recordOrder()
    const { requestAndRegister } = await import('./pushNotifications')

    await requestAndRegister()
    await settle()

    expect(order).toEqual(['subscribed', 'registered'])
  })

  it('subscribes before registering when repairing on mount', async () => {
    const order = recordOrder()
    const { syncPushRegistration } = await import('./pushNotifications')

    await syncPushRegistration()
    await settle()

    expect(order).toEqual(['subscribed', 'registered'])
  })

  // The first-time enable records the device, which is the whole point: without
  // it the backend never learns the FID, never sets the preference, and the
  // feature can never turn itself on.
  it('records the device on a first-time enable', async () => {
    const { requestAndRegister } = await import('./pushNotifications')

    await requestAndRegister()
    await settle()
    emitRegistered()
    await settle()

    expect(mocks.registerSubscription).toHaveBeenCalledWith(FID)
  })
})

// The three ways this could still fail silently. Each was a real defect: none
// throws, none logs anything a user would see, and each ends in "notifications
// are on and nothing arrives" or "notifications are off and I did not do that".
describe('silent-failure guards', () => {
  // A failed POST must not be latched: the next registration event has to try
  // again, or one offline moment leaves the device unrecorded for the session.
  it('records again after a failed registration', async () => {
    mocks.registerSubscription.mockRejectedValueOnce(new Error('offline'))

    const { ensureRegistrationWatch } = await import('./pushNotifications')
    await ensureRegistrationWatch()
    await settle()

    emitRegistered('fid-1')
    await settle()
    emitRegistered('fid-2')
    await settle()

    expect(mocks.registerSubscription).toHaveBeenNthCalledWith(1, 'fid-1')
    expect(mocks.registerSubscription).toHaveBeenNthCalledWith(2, 'fid-2')
  })

  // Resolving on a failed install would tell the caller the listener is up. It
  // would then register, and the FID would be delivered to nobody.
  it('reports a failed install instead of pretending it worked', async () => {
    Object.defineProperty(navigator, 'serviceWorker', {
      value: {
        register: vi.fn().mockRejectedValue(new Error('no worker')),
        getRegistration: vi.fn(),
        getRegistrations: vi.fn(),
      },
      configurable: true,
    })

    const { ensureRegistrationWatch, requestAndRegister } = await import('./pushNotifications')
    await expect(ensureRegistrationWatch()).rejects.toThrow('no worker')

    // And the enable path must not register into the void.
    expect(await requestAndRegister()).not.toBe('granted')
    expect(mocks.register).not.toHaveBeenCalled()
  })

  it('reinstalls on a later attempt rather than staying broken', async () => {
    const swRegister = vi
      .fn()
      .mockRejectedValueOnce(new Error('no worker'))
      .mockResolvedValue(mocks.swRegistration)
    Object.defineProperty(navigator, 'serviceWorker', {
      value: { register: swRegister, getRegistration: vi.fn(), getRegistrations: vi.fn() },
      configurable: true,
    })

    const { ensureRegistrationWatch } = await import('./pushNotifications')
    await expect(ensureRegistrationWatch()).rejects.toThrow('no worker')
    await expect(ensureRegistrationWatch()).resolves.toBeUndefined()

    expect(mocks.onRegistered).toHaveBeenCalledTimes(1)
  })

  // unregister() echoes onUnregistered for the FID just deleted. A second
  // delete also clears notificationDelivery.browser, so one landing after a
  // re-enable switches the channel off behind the person who just turned it on.
  it('does not delete the same device twice when turning off', async () => {
    const mod = await import('./pushNotifications')
    await mod.ensureRegistrationWatch()
    await settle()
    emitRegistered()
    await settle()

    mocks.deleteSubscription.mockClear()
    await mod.unregisterPush()
    emitUnregistered()
    await settle()

    expect(mocks.deleteSubscription).toHaveBeenCalledTimes(1)
  })

  // If the delete failed, nothing was retired — so the echo is the only
  // remaining chance to get this device off the send list, and must go through.
  it('lets the echo retire the device when the explicit delete failed', async () => {
    const mod = await import('./pushNotifications')
    await mod.ensureRegistrationWatch()
    await settle()
    emitRegistered()
    await settle()

    mocks.deleteSubscription.mockClear()
    mocks.deleteSubscription.mockRejectedValueOnce(new Error('offline'))
    await mod.unregisterPush()
    mocks.deleteSubscription.mockResolvedValue(undefined)
    emitUnregistered()
    await settle()

    expect(mocks.deleteSubscription).toHaveBeenCalledTimes(2)
  })
})

// The silent-listener failure, frozen.
//
// onRegistered is a CHANGE notification, not a getter: it does not fire when a
// repeat register() resolves to the identifier the device already had. Every
// flow except a first-ever enable is that case, so a design that waited to be
// handed the FID sent NO request at all — the backend saw nothing, and the
// toggle on dashboard/settings/communication looked inert in both directions.
//
// Every test here runs with a listener that never fires.
describe('when onRegistered stays silent', () => {
  beforeEach(() => {
    mocks.onRegistered.mockReturnValue(vi.fn())
  })

  it('still records the device when enabling', async () => {
    const { requestAndRegister } = await import('./pushNotifications')

    expect(await requestAndRegister()).toBe('granted')
    await settle()

    expect(mocks.registerSubscription).toHaveBeenCalledWith(FID)
  })

  it('still records the device when repairing on mount', async () => {
    const { syncPushRegistration } = await import('./pushNotifications')

    await syncPushRegistration()
    await settle()

    expect(mocks.registerSubscription).toHaveBeenCalledWith(FID)
  })

  // The disable half. A page loaded with notifications already on has had no
  // registration event at all, so there was never an FID to name and the DELETE
  // was skipped — which is why the channel could not be turned off.
  it('still retires the device when disabling', async () => {
    const { unregisterPush } = await import('./pushNotifications')

    await unregisterPush()

    expect(mocks.deleteSubscription).toHaveBeenCalledWith(FID)
    expect(mocks.unregister).toHaveBeenCalledTimes(1)
  })

  // The full round trip the person actually performs in Settings.
  it('survives disable then re-enable', async () => {
    const mod = await import('./pushNotifications')

    await mod.syncPushRegistration()
    await settle()
    expect(mocks.registerSubscription).toHaveBeenCalledTimes(1)

    await mod.unregisterPush()
    expect(mocks.deleteSubscription).toHaveBeenCalledWith(FID)

    mocks.registerSubscription.mockClear()
    expect(await mod.requestAndRegister()).toBe('granted')
    await settle()

    // Must record again. Deduplicating against the registration just retired
    // would leave the preference off with the toggle showing on.
    expect(mocks.registerSubscription).toHaveBeenCalledWith(FID)
  })

  // One registration must not be posted twice just because the listener also
  // happened to fire for it.
  it('does not record the same device twice', async () => {
    const { syncPushRegistration } = await import('./pushNotifications')

    await syncPushRegistration()
    await settle()
    emitRegistered(FID)
    await settle()

    expect(mocks.registerSubscription).toHaveBeenCalledTimes(1)
  })

  it('reports honestly when the device has no id', async () => {
    mocks.getId.mockResolvedValue('')
    const { requestAndRegister } = await import('./pushNotifications')

    expect(await requestAndRegister()).toBe('default')
    expect(mocks.registerSubscription).not.toHaveBeenCalled()
  })
})

// A broken rotation listener must not be able to stop somebody turning
// notifications on.
//
// It was exactly that. onRegistered/onUnregistered are installed by
// ensureRegistrationWatch, both enable paths awaited it, and unregisterPush did
// not — so disable could work while enable sent nothing at all.
// The FID is READ now, so the listener is an enhancement, not a precondition.
describe('when the rotation watch cannot be installed', () => {
  beforeEach(() => {
    mocks.onRegistered.mockImplementation(() => {
      throw new Error('listener unavailable')
    })
  })

  it('still enables', async () => {
    const { requestAndRegister } = await import('./pushNotifications')

    expect(await requestAndRegister()).toBe('granted')
    await settle()

    expect(mocks.register).toHaveBeenCalledTimes(1)
    expect(mocks.registerSubscription).toHaveBeenCalledWith(FID)
  })

  it('still repairs on mount', async () => {
    const { syncPushRegistration } = await import('./pushNotifications')

    await syncPushRegistration()
    await settle()

    expect(mocks.registerSubscription).toHaveBeenCalledWith(FID)
  })

  it('still disables', async () => {
    const { unregisterPush } = await import('./pushNotifications')

    await unregisterPush()

    expect(mocks.deleteSubscription).toHaveBeenCalledWith(FID)
  })
})

// If FCM registration itself fails there is no delivery to record. Reporting
// success would show the channel as on with nothing behind it — the half-state
// this module's history is a list of.
describe('when FCM registration fails', () => {
  it('reports honestly and records nothing', async () => {
    mocks.register.mockRejectedValue(new Error('FCM unavailable'))
    const { requestAndRegister } = await import('./pushNotifications')

    expect(await requestAndRegister()).toBe('default')
    expect(mocks.registerSubscription).not.toHaveBeenCalled()
  })
})

// Enabling and the mount sync fire within ~50ms of each other, and both record
// the device. Unguarded, that produces two identical 201s for one registration.
//
// recordedFid alone cannot prevent it: it is set only after the POST succeeds —
// deliberately, so a failure is retried rather than latched — which leaves a
// window where both callers see "not recorded yet".
describe('concurrent registration', () => {
  it('posts once when a second caller arrives mid-registration', async () => {
    let release: (() => void) | undefined
    mocks.registerSubscription.mockImplementation(
      () => new Promise<void>((resolve) => { release = () => resolve() }),
    )

    const mod = await import('./pushNotifications')

    // First flow reaches the POST and blocks there.
    const first = mod.syncPushRegistration()
    await settle()
    expect(mocks.registerSubscription).toHaveBeenCalledTimes(1)

    // Second arrives while the first is still in flight — the ~50ms window that
    // would otherwise produce two identical 201s.
    const second = mod.requestAndRegister()
    await settle()

    release?.()
    await Promise.all([first, second])

    expect(mocks.registerSubscription).toHaveBeenCalledTimes(1)
  })

  // Joining means joining, not skipping: the second caller must not return
  // before the device is actually recorded.
  it('makes the joining caller wait for the real result', async () => {
    let release: (() => void) | undefined
    mocks.registerSubscription.mockImplementation(
      () => new Promise<void>((resolve) => { release = () => resolve() }),
    )

    const mod = await import('./pushNotifications')
    const first = mod.syncPushRegistration()
    await settle()
    const second = mod.requestAndRegister()

    let secondDone = false
    void second.then(() => { secondDone = true })
    await settle()
    expect(secondDone).toBe(false)

    release?.()
    await first
    await second
    expect(secondDone).toBe(true)
  })

  // A failed attempt must not be latched: the next caller has to try again,
  // or one offline moment leaves the device unregistered for the session.
  it('retries after a failed registration', async () => {
    mocks.registerSubscription.mockRejectedValueOnce(new Error('offline'))
    const mod = await import('./pushNotifications')

    await mod.syncPushRegistration()
    await settle()
    await mod.requestAndRegister()
    await settle()

    expect(mocks.registerSubscription).toHaveBeenCalledTimes(2)
  })
})
