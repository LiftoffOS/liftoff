// Browser push subscription registration.
//
// Through apiFetch like every other backend call (services-layer invariant):
// these endpoints are authed and the Firebase token has to travel with them.

import { api, apiFetch } from './api'

export interface PushSubscriptionCreated {
  id: string
}

/**
 * Register this browser against the signed-in account by its Firebase
 * Installation ID.
 *
 * Safe to call repeatedly. The backend upserts on the FID, so re-registering
 * updates the existing row rather than accumulating one per session.
 *
 */
export async function registerPushSubscription(
  fid: string,
): Promise<PushSubscriptionCreated> {
  return await api.post<PushSubscriptionCreated>('/api/push/subscriptions', { fid })
}

/**
 * Retire this browser.
 *
 * A DELETE carrying a body, which api.delete does not support: these
 * identifiers are long enough to be awkward in a path and keeping them out of
 * the URL keeps them out of access logs.
 */
export async function deletePushSubscription(fid: string): Promise<void> {
  await apiFetch<void>('/api/push/subscriptions', {
    method: 'DELETE',
    body: JSON.stringify({ fid }),
  })
}
