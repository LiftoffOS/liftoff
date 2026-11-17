// Browser push: permission state and device registration.
//
// One resolver and one action, so every surface that offers to turn
// notifications on asks the same question and takes the same path.
//
// A device is identified by its Firebase Installation ID (FID). `getToken()` is
// deprecated in favour of `register()` + `onRegistered()`, and the reason to
// move is not tidiness: `getToken` only ever returned a token when the app was
// open, so a browser that rotated its push subscription while nobody visited
// Liftoff left us holding a dead identifier. FCM keeps ACCEPTING sends against
// one of those — reporting success — while nothing arrives. `onRegistered`
// fires on manual register, on FID change, AND on `pushsubscriptionchange`,
// which is the event that closes that hole.
//
// The FID arrives through a callback rather than a return value, so the
// registration flow here is split in two: `requestAndRegister()` owns the
// permission prompt, and `subscribeToRegistration()` owns sending whatever FID
// turns up to the backend, whenever it turns up.

import { app, vapidKey } from '../config/firebase'
import { registerPushSubscription, deletePushSubscription } from '../services/pushSubscriptions'

/**
 * What this device can currently do.
 *
 * `unavailable` is a real state, not an error. On iOS Safari the Notification
 * and Push APIs are absent entirely until the site is installed to the Home
 * Screen, and a build without a VAPID key cannot register at all. Both must
 * render nothing rather than an Enable button that cannot work.
 */
export type PushPermissionState = 'granted' | 'denied' | 'default' | 'unavailable'

const SW_PATH = '/firebase-messaging-sw.js'

/**
 * The last FID this device was issued, remembered so unregistering can name the
 * row it is retiring.
 *
 * `register()` does not return the FID and there is no getter for it — it only
 * ever arrives through `onRegistered`. Turning notifications OFF has to send a
 * DELETE naming this device, because that endpoint is also what clears
 * `notificationDelivery.browser` server-side. Without a remembered value the
 * disable path would depend on `onUnregistered` firing, and a preference left
 * on with nothing behind it is precisely the half-state this module's history
 * is a list of.
 */
let lastKnownFid: string | null = null

/** Everything the browser must provide before push is even possible. */
function isSupported(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof navigator !== 'undefined' &&
    'serviceWorker' in navigator &&
    'PushManager' in window &&
    typeof Notification !== 'undefined'
  )
}

/**
 * Resolve this device's state. Synchronous and cheap: safe to call on every
 * render that needs to decide whether to show a prompt.
 */
export function getPushPermissionState(): PushPermissionState {
  if (!isSupported()) return 'unavailable'
  // A build with no key can request permission and then fail to register, which
  // is worse than not offering: the person grants access and gets nothing.
  if (!vapidKey) return 'unavailable'
  const permission = Notification.permission
  if (permission === 'granted') return 'granted'
  if (permission === 'denied') return 'denied'
  return 'default'
}

/**
 * Register the service worker that receives messages while no tab is focused.
 *
 * Explicit rather than letting the Messaging SDK find it by convention, so the
 * scope is ours and a failure surfaces here instead of inside the SDK.
 */
async function registerServiceWorker(): Promise<ServiceWorkerRegistration> {
  return await navigator.serviceWorker.register(SW_PATH, { scope: '/' })
}

/**
 * This device's Firebase Installation ID, read directly.
 *
 * `onRegistered` is a CHANGE notification, not a getter: it does not fire when
 * a repeat `register()` resolves to the identifier the device already had. That
 * is the common case for every flow except a first-ever enable, so a design
 * that waited to be handed the FID silently did nothing on disable and on
 * re-enable — no request left the browser at all.
 *
 * getId() is the canonical read and always answers. The listeners stay, for the
 * case only they can catch: a rotation arriving with no call behind it.
 *
 * Returns null rather than throwing: a caller with no FID has nothing to say to
 * the backend, which is a state to handle, not an error to raise.
 */
async function currentFid(): Promise<string | null> {
  try {
    const { getInstallations, getId } = await import('firebase/installations')
    const fid = await getId(getInstallations(app))
    return fid || null
  } catch (err) {
    console.warn('[push] could not read this device id:', err)
    return null
  }
}

/**
 * FIDs this client retired itself, awaiting the `onUnregistered` echo.
 *
 * `unregister()` deletes server-side first and then fires `onUnregistered` for
 * the same FID, so without this the listener sends a SECOND delete. Both clear
 * `notificationDelivery.browser`, so somebody who turns notifications off and
 * straight back on can have the late one land after the re-enable and switch
 * the channel off behind them — a preference off with a live device, which is
 * the half-state nothing in the UI can explain or repair.
 */
const retiredHere = new Set<string>()

/** The one-per-page listener installation, or null before the first attempt. */
let watchInstalled: Promise<void> | null = null

/** The FID the backend has already been told about, so the explicit call after
 *  register() and a listener firing for the same registration do not both post
 *  it. Cleared on unregister so a re-enable always records again. */
let recordedFid: string | null = null

/** The registration currently in flight, so concurrent callers JOIN it rather
 *  than each starting their own. `recordedFid` alone cannot do this: it is only
 *  set once the POST has succeeded — deliberately, so a failure is retried
 *  rather than latched — which leaves a window where two callers both see "not
 *  recorded yet" and both post. That window is not theoretical: enabling and
 *  the mount sync fire ~50ms apart, so both would post. */
let recordingInFlight: { fid: string; done: Promise<void> } | null = null

/**
 * Tell the backend about this device.
 *
 * The single place that posts a registration, so the legacy handover and the
 * de-duplication cannot drift between the paths that call it.
 *
 * Safe to call concurrently: a second caller for the same FID awaits the first
 * rather than repeating it, and still returns only once the device is recorded.
 */
async function recordDevice(fid: string): Promise<void> {
  if (recordedFid === fid) return
  if (recordingInFlight?.fid === fid) return recordingInFlight.done

  const done = (async () => {
    try {
      await registerPushSubscription(fid)
      recordedFid = fid
      lastKnownFid = fid
    } catch (err) {
      console.warn('[push] could not record this device:', err)
    }
  })()

  recordingInFlight = { fid, done }
  try {
    await done
  } finally {
    // Cleared whatever happened, so a failed attempt is retried by the next
    // caller instead of being deduplicated against a registration that never
    // landed.
    if (recordingInFlight?.fid === fid) recordingInFlight = null
  }
}

/**
 * Install the FID listeners, exactly once per page.
 *
 * Idempotent and awaited by every caller that is about to trigger a
 * registration. That ordering is the whole contract: `register()` delivers its
 * FID through `onRegistered` and nowhere else, so registering before the
 * listener exists loses it silently, and the device is never recorded.
 *
 * The listeners are never torn down. They cost one subscription per page, and
 * the alternative — releasing them when a component unmounts — would drop
 * exactly the late, unprompted events (`pushsubscriptionchange`) this exists to
 * catch. If a different account signs in on the same browser, re-registering
 * its device against the new account is CORRECT: the backend's upsert reassigns
 * the row deliberately for that case.
 *
 * REJECTS on failure, and clears the latch so a later attempt reinstalls rather
 * than inheriting a permanently rejected promise. Resolving on failure would be
 * worse than useless: the caller would take it as "the listener is up", call
 * register(), and lose the FID to nobody — the exact silent hole this ordering
 * exists to close.
 */
export function ensureRegistrationWatch(): Promise<void> {
  if (getPushPermissionState() === 'unavailable') return Promise.resolve()

  if (!watchInstalled) {
    watchInstalled = (async () => {
      await registerServiceWorker()
      const { getMessaging, onRegistered, onUnregistered } = await import('firebase/messaging')
      const messaging = getMessaging(app)

      // A rotation arriving with no call behind it — the one case the explicit
      // read after register() cannot cover.
      onRegistered(messaging, (fid) => {
        lastKnownFid = fid
        void recordDevice(fid)
      })

      // FCM telling us an FID is no longer active. Retiring it here stops the
      // backend sending to a device that cannot receive, which would otherwise
      // look like a successful send forever.
      onUnregistered(messaging, (fid) => {
        if (lastKnownFid === fid) lastKnownFid = null
        // Already retired by unregisterPush, which deletes server-side before
        // clearing local state. Consuming the echo rather than repeating the
        // delete is what stops a late one landing after a re-enable.
        if (retiredHere.delete(fid)) return
        void deletePushSubscription(fid).catch((err) => {
          console.warn('[push] could not retire this device:', err)
        })
      })
    })().catch((err: unknown) => {
      watchInstalled = null
      throw err
    })
  }

  return watchInstalled
}

/**
 * Watch for FIDs, then re-assert this device's registration.
 *
 * Called on mount for an account that already wants browser notifications. The
 * re-assertion is what repairs a device whose identifier changed while the app
 * was closed; the listener is the half that catches a change happening WHILE it
 * is open.
 *
 * Silent on failure: nobody asked for anything here, so there is no one to tell.
 */
export async function syncPushRegistration(): Promise<void> {
  if (getPushPermissionState() !== 'granted') return
  try {
    // Best effort, never a gate. The watch only catches rotations that arrive
    // with no call behind them; the FID this path needs is READ below. Letting
    // it block registration made one optional listener the single point of
    // failure for turning notifications on at all.
    await ensureRegistrationWatch().catch((err: unknown) => {
      console.warn('[push] rotation watch unavailable; registration continues:', err)
    })

    const registration = await registerServiceWorker()
    const { getMessaging, register } = await import('firebase/messaging')
    await register(getMessaging(app), { vapidKey, serviceWorkerRegistration: registration })

    // Read it rather than wait to be handed it. onRegistered does not fire when
    // register() resolves to the identifier the device already had, which is
    // every repeat visit.
    const fid = await currentFid()
    if (fid) await recordDevice(fid)
  } catch (err) {
    console.warn('[push] registration sync failed:', err)
  }
}

/**
 * Ask the browser for permission and register this device.
 *
 * MUST be called from a click handler. Safari requires the permission request
 * to come from direct user interaction, and Chrome embargoes an origin after
 * three dismissals, so an unprompted call is both broken on one browser and
 * expensive on another. Nothing is awaited before `Notification.requestPermission()`
 * for the same reason.
 *
 * Returns the state the device ended in, so the caller can re-render from one
 * value rather than inferring what happened.
 *
 * `register()` resolves once registration has been INITIATED; the FID itself
 * arrives at the `onRegistered` subscription above. So a `granted` here means
 * permission was granted and registration started, not that the backend has
 * heard about it yet.
 */
export async function requestAndRegister(): Promise<PushPermissionState> {
  if (getPushPermissionState() === 'unavailable') return 'unavailable'

  try {
    const permission = await Notification.requestPermission()
    if (permission !== 'granted') {
      // Covers both an explicit block and a dismissal, which reports 'default'.
      // Neither is an error and neither should be retried automatically.
      return permission === 'denied' ? 'denied' : 'default'
    }

    // Listener FIRST. register() delivers its FID through onRegistered and
    // nowhere else, so registering before the listener exists loses it — and
    // this is a FIRST-TIME enable, where the app-scope watch has not started
    // because the account does not yet want browser notifications. Without
    // this, the very flow that turns the feature on is the one that cannot
    // record a device.
    // Best effort, never a gate — see syncPushRegistration. This path reads the
    // FID itself, so the listener is an enhancement and must not be able to
    // stop somebody turning notifications on.
    await ensureRegistrationWatch().catch((err: unknown) => {
      console.warn('[push] rotation watch unavailable; registration continues:', err)
    })

    const registration = await registerServiceWorker()

    // Dynamic so the FCM client is only downloaded by someone who actually
    // enables notifications. vite.config.ts excludes messaging from the
    // vendor-firebase manual chunk for this to hold: folded in, it sat behind a
    // modulepreload in index.html and cost every first paint 3.9 KB gzipped for
    // a feature most visitors never touch.
    const { getMessaging, register } = await import('firebase/messaging')
    try {
      await register(getMessaging(app), {
        vapidKey,
        serviceWorkerRegistration: registration,
      })
    } catch (err) {
      // Distinct from every other failure here. Without delivery established
      // there is nothing to record, and recording anyway would show the channel
      // as on with nothing behind it.
      console.warn('[push] FCM registration failed:', err)
      return 'default'
    }

    // Read it rather than wait to be handed it. On a RE-enable the device
    // already has an FID, so onRegistered stays silent and nothing would ever
    // reach the backend — the preference would stay off and the toggle would
    // look inert.
    const fid = await currentFid()
    if (!fid) {
      console.warn('[push] permission granted but this device has no id')
      return 'default'
    }
    await recordDevice(fid)

    return 'granted'
  } catch (err) {
    console.warn('[push] could not enable notifications:', err)
    // Permission was very likely granted before whatever failed — the prompt is
    // the first thing this does. Returning 'granted' would claim success for a
    // device that was never recorded, and the person would sit waiting for
    // notifications that cannot arrive, with the prompt gone because the UI
    // reads 'granted' as done. 'default' keeps the Enable affordance visible so
    // it can be retried, which is the only honest report of "permission yes,
    // registration no".
    const state = getPushPermissionState()
    return state === 'granted' ? 'default' : state
  }
}

/**
 * Retire this browser's registration, server-side and locally.
 *
 * Does NOT revoke the OS permission, because no API can. Turning the preference
 * off stops us sending; the browser keeps its grant until the person changes it
 * in browser settings.
 */
export async function unregisterPush(): Promise<void> {
  if (!isSupported() || !vapidKey) return
  try {
    const registration = await navigator.serviceWorker.getRegistration(SW_PATH)
    if (!registration) return

    const { getMessaging, unregister } = await import('firebase/messaging')
    const messaging = getMessaging(app)

    // Server FIRST, and explicitly. This DELETE is also what clears
    // notificationDelivery.browser, so it is not optional cleanup: skipping it
    // leaves the preference advertising a channel with nothing behind it.
    //
    // Done here rather than left to onUnregistered because that callback only
    // fires if something is still subscribed to it, and this must work even
    // when it is not. If the FID is unknown — a fresh load where register() has
    // not run yet — onUnregistered below remains the backstop.
    // Read it if we were never told. A page that loaded with notifications
    // already on has had no registration EVENT, so lastKnownFid is null and the
    // delete would have been skipped — which is exactly why turning the channel
    // off did nothing.
    const fid = lastKnownFid ?? (await currentFid())

    if (fid) {
      // Claimed BEFORE the delete, not after: unregister() below fires
      // onUnregistered for this same FID, and the listener has to be able to
      // recognise the echo as ours even if it arrives while the delete is still
      // in flight.
      retiredHere.add(fid)
      try {
        await deletePushSubscription(fid)
      } catch (err) {
        // Nothing was retired, so the echo is no longer a duplicate — it is the
        // only remaining chance to get this device off the send list. Release
        // the claim and let the listener through.
        retiredHere.delete(fid)
        throw err
      }
      lastKnownFid = null
      // Cleared so a re-enable records this device again rather than being
      // deduplicated against the registration we just retired.
      recordedFid = null
      recordingInFlight = null
    }

    await unregister(messaging)
  } catch (err) {
    console.warn('[push] could not fully unregister notifications:', err)
  }
}
