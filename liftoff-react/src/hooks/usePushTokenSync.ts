// Keeps this browser's push registration alive.
//
// Without this, a device is only ever registered on the click that enables
// notifications, and that click happens once. Firebase reissues a device's
// identifier: on its own schedule, when a browser prunes site data, when a
// service worker is replaced, when the push subscription is rotated. A stale
// identifier is not an error anywhere — it simply stops matching a device, FCM
// keeps ACCEPTING sends against it and reporting success, and the person stops
// receiving notifications with nothing to see and nothing logged on their side.
//
// So the registration is watched for as long as the app is open, for accounts
// that have already asked for browser notifications and already granted
// permission. syncPushRegistration installs the listeners and then re-asserts
// the registration, so a repeat is a no-op write and a rotation is a silent
// repair. The listener is the half that matters most: `onRegistered` fires on
// `pushsubscriptionchange` too, which is the case a once-per-session read could
// never catch.
//
// Deliberately does NOT prompt. It only runs when permission is already
// granted, so it can never put a browser dialog in front of somebody who did
// not just ask for one.
//
// It also stays gated on the account WANTING browser delivery. Registration
// sets that preference server-side, so running this unconditionally would
// re-enable somebody who had deliberately turned the channel off in Settings:
// their device was retired, permission is still granted, and the next page load
// would quietly hand it back.

import { useEffect } from 'react'
import { useAuth } from '../contexts/AuthContext'
import { getPushPermissionState, syncPushRegistration } from '../lib/pushNotifications'

export function usePushTokenSync(): void {
  const { account } = useAuth()

  const wanted = account?.preferences?.notificationDelivery?.browser === true

  useEffect(() => {
    if (!wanted) return
    if (getPushPermissionState() !== 'granted') return
    // No cleanup. The listener is installed once per page and deliberately
    // outlives this component: releasing it on unmount would drop exactly the
    // late, unprompted events (`pushsubscriptionchange`) it exists to catch.
    void syncPushRegistration()
  }, [wanted])
}
