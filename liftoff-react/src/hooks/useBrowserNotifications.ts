// Turning browser notifications on, in one place.
//
// Enabling used to be two writes from here: register the token, then PATCH
// preferences.notificationDelivery.browser. That split had a silent failure
// mode and it happened — the preferences schema is .strict(), did not yet know
// the key, and 400'd while the token write succeeded. The result was a live
// token with delivery off, which nothing could repair: the banner hides once
// permission is granted, and the token sync deliberately does not touch
// preferences.
//
// So the backend owns both now. POST /api/push/subscriptions registers the
// device AND sets the preference, because registering a device IS opting into
// browser delivery. One request, one outcome, no half-state to reconcile.
//
// This refreshes the account afterwards so Settings and every banner see the
// new value without waiting for the next navigation.

import { useCallback } from 'react'
import { useAuth } from '../contexts/AuthContext'
import {
  requestAndRegister,
  unregisterPush,
  type PushPermissionState,
} from '../lib/pushNotifications'

export function useEnableBrowserNotifications(): () => Promise<PushPermissionState> {
  const { refreshAccount } = useAuth()

  return useCallback(async () => {
    // Nothing awaited ahead of this: Safari requires the permission request to
    // come from direct user interaction, and an await before it loses the
    // gesture, so the prompt never appears.
    const state = await requestAndRegister()

    if (state !== 'granted') return state

    // The preference was written server-side by the registration. Pull it so
    // the UI stops asking and Settings shows the channel as on.
    try {
      await refreshAccount()
    } catch {
      // The registration succeeded, which is what mattered. A stale local copy
      // corrects itself on the next load, and reporting a failure here would
      // describe something that did not fail.
    }

    return state
  }, [refreshAccount])
}

/**
 * Turn browser notifications off for this device.
 *
 * The mirror of enabling, and owned by the same endpoint: DELETE
 * /api/push/subscriptions retires the token AND clears
 * notificationDelivery.browser, so this cannot leave the preference on with
 * nothing behind it.
 *
 * It does NOT revoke the browser's permission, because no API can. The grant
 * stays until the person changes it in browser settings; what stops is us
 * sending.
 */
export function useDisableBrowserNotifications(): () => Promise<void> {
  const { refreshAccount } = useAuth()

  return useCallback(async () => {
    await unregisterPush()
    try {
      await refreshAccount()
    } catch {
      // Same reasoning as enabling: the revoke is what mattered, and a stale
      // local copy corrects itself on the next load.
    }
  }, [refreshAccount])
}
