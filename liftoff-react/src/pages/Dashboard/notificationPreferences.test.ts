// The shallow-merge rule, as a test rather than a comment.
//
// The backend merges preferences with JSONB `||`, which REPLACES a nested
// object rather than merging into it. Sending one changed key therefore deletes
// every sibling, silently: the write succeeds, nothing errors, and three
// notification types quietly turn on or off behind the person's back.
//
// These sections save on every toggle now, so the partial-object mistake would
// fire on a single click rather than once per Save.

import { describe, it, expect } from 'vitest'
import {
  notificationTypeValue,
  deliveryValue,
  withNotificationTypeToggled,
  withDeliveryToggled,
  DEFAULT_NOTIFICATION_TYPES,
  DEFAULT_NOTIFICATION_DELIVERY,
} from './notificationPreferences'

describe('reading a saved value', () => {
  it('falls back to the default when the account has no preference yet', () => {
    expect(notificationTypeValue(undefined, 'taskUpdates')).toBe(true)
    expect(deliveryValue(undefined, 'email')).toBe(true)
  })

  // Browser needs an OS permission we cannot grant, so defaulting it on would
  // claim a capability the account does not have.
  it('defaults browser delivery to off', () => {
    expect(deliveryValue(undefined, 'browser')).toBe(false)
    expect(DEFAULT_NOTIFICATION_DELIVERY.browser).toBe(false)
  })

  it('prefers a stored value over the default', () => {
    expect(notificationTypeValue({ taskUpdates: false }, 'taskUpdates')).toBe(false)
    expect(deliveryValue({ browser: true }, 'browser')).toBe(true)
  })

  // Migration 398 turned this off for existing accounts, but the column default
  // stays on, so a fresh signup still gets a recap a week in.
  it('keeps the weekly digest default on for a new account', () => {
    expect(DEFAULT_NOTIFICATION_TYPES.weeklyDigest).toBe(true)
  })
})

describe('toggling a notification type', () => {
  it('returns every key, not just the changed one', () => {
    const next = withNotificationTypeToggled({ taskUpdates: true }, 'taskUpdates')
    expect(Object.keys(next).sort()).toEqual(
      ['escalations', 'taskUpdates', 'teamActivity', 'weeklyDigest'],
    )
  })

  it('flips only the requested key', () => {
    const saved = { taskUpdates: true, teamActivity: false, escalations: true, weeklyDigest: false }
    expect(withNotificationTypeToggled(saved, 'taskUpdates')).toEqual({
      taskUpdates: false,
      teamActivity: false,
      escalations: true,
      weeklyDigest: false,
    })
  })

  // The case the shallow merge punishes: three siblings are stored false, and a
  // partial object would drop them and let the defaults turn them back on.
  it('preserves siblings that differ from the defaults', () => {
    const saved = { taskUpdates: true, teamActivity: false, escalations: false, weeklyDigest: false }
    const next = withNotificationTypeToggled(saved, 'taskUpdates')
    expect(next.teamActivity).toBe(false)
    expect(next.escalations).toBe(false)
    expect(next.weeklyDigest).toBe(false)
  })

  it('fills absent siblings from the defaults rather than leaving them undefined', () => {
    const next = withNotificationTypeToggled({ taskUpdates: false }, 'taskUpdates')
    expect(next.teamActivity).toBe(true)
    expect(Object.values(next).every((v) => typeof v === 'boolean')).toBe(true)
  })
})

describe('toggling a delivery channel', () => {
  it('returns both channels, so the other is never dropped', () => {
    const next = withDeliveryToggled({ email: false, browser: true }, 'browser')
    expect(next).toEqual({ email: false, browser: false })
  })

  it('turns browser on from an account that has no delivery preference', () => {
    expect(withDeliveryToggled(undefined, 'browser')).toEqual({ email: true, browser: true })
  })

  it('does not disturb email when browser changes', () => {
    expect(withDeliveryToggled({ email: false }, 'browser').email).toBe(false)
  })
})
