// Building a complete notification preference object.
//
// The backend merges preferences with a shallow JSONB `||`, so a nested
// partial REPLACES the whole object rather than merging into it. Sending
// { notificationTypes: { taskUpdates: false } } does not turn one type off, it
// deletes the other three. The rule has been a comment in SettingsPage since
// the section was written; it lives here so it is enforced and tested instead.

import type { NotificationTypes, NotificationDelivery } from '../../services/account'

/** Every type ON. Matches the column default set by migration 206, and covers
 *  an account whose row predates that backfill. */
export const DEFAULT_NOTIFICATION_TYPES: Required<NotificationTypes> = {
  taskUpdates: true,
  teamActivity: true,
  escalations: true,
  weeklyDigest: true,
}

/** Email on, browser off. Browser cannot work without an OS permission the
 *  person grants in their own browser, so defaulting it on would claim a
 *  capability the account does not have. */
export const DEFAULT_NOTIFICATION_DELIVERY: Required<NotificationDelivery> = {
  email: true,
  browser: false,
}

/** The saved value of one type, with defaults filled in. */
export function notificationTypeValue(
  saved: NotificationTypes | undefined,
  key: keyof Required<NotificationTypes>,
): boolean {
  return { ...DEFAULT_NOTIFICATION_TYPES, ...saved }[key]
}

/** The saved value of one delivery channel, with defaults filled in. */
export function deliveryValue(
  saved: NotificationDelivery | undefined,
  key: keyof Required<NotificationDelivery>,
): boolean {
  return { ...DEFAULT_NOTIFICATION_DELIVERY, ...saved }[key]
}

/** One type flipped, as a COMPLETE object safe to send to a shallow merge. */
export function withNotificationTypeToggled(
  saved: NotificationTypes | undefined,
  key: keyof Required<NotificationTypes>,
): Required<NotificationTypes> {
  return {
    ...DEFAULT_NOTIFICATION_TYPES,
    ...saved,
    [key]: !notificationTypeValue(saved, key),
  }
}

/** One channel flipped, as a COMPLETE object safe to send to a shallow merge. */
export function withDeliveryToggled(
  saved: NotificationDelivery | undefined,
  key: keyof Required<NotificationDelivery>,
): Required<NotificationDelivery> {
  return {
    ...DEFAULT_NOTIFICATION_DELIVERY,
    ...saved,
    [key]: !deliveryValue(saved, key),
  }
}
