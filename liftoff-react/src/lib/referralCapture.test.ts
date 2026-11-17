import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  captureReferralCode,
  clearCapturedReferral,
  getCapturedReferral,
} from './referralCapture'

const KEY = 'liftoff.referral'
const DAY_MS = 24 * 60 * 60 * 1000

beforeEach(() => {
  window.localStorage.clear()
  vi.restoreAllMocks()
})

describe('capture', () => {
  it('stores a code off the landing URL', () => {
    captureReferralCode('?ref=k7m2q9')

    expect(getCapturedReferral()?.code).toBe('k7m2q9')
  })

  it('lets the last touch win', () => {
    captureReferralCode('?ref=first-0001')
    captureReferralCode('?ref=second-0002')

    // Last-click is the default across affiliate tooling and the model partners
    // expect; first-touch mainly matters where several partners compete over
    // one lead, which is not a customer-to-customer programme.
    expect(getCapturedReferral()?.code).toBe('second-0002')
  })

  it('lower-cases, so a link typed in caps still attributes', () => {
    captureReferralCode('?ref=K7M2Q9')

    expect(getCapturedReferral()?.code).toBe('k7m2q9')
  })

  it('ignores a URL with no code', () => {
    captureReferralCode('?utm_source=newsletter')

    expect(getCapturedReferral()).toBeNull()
  })

  it('refuses a value that is not code-shaped', () => {
    // Never stored, so it can never be sent, so it is never something the
    // backend has to defend against.
    captureReferralCode('?ref=' + encodeURIComponent('<script>alert(1)</script>'))
    expect(getCapturedReferral()).toBeNull()

    captureReferralCode('?ref=' + 'x'.repeat(60))
    expect(getCapturedReferral()).toBeNull()
  })
})

describe('the attribution window', () => {
  it('keeps a click inside 30 days', () => {
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        code: 'k7m2q9',
        clickedAt: new Date(Date.now() - 29 * DAY_MS).toISOString(),
      }),
    )

    expect(getCapturedReferral()?.code).toBe('k7m2q9')
  })

  it('drops a click older than 30 days', () => {
    // A longer window buys mainly stale attribution: somebody who clicked,
    // forgot, and found Liftoff organically months later was already acquired.
    window.localStorage.setItem(
      KEY,
      JSON.stringify({
        code: 'k7m2q9',
        clickedAt: new Date(Date.now() - 31 * DAY_MS).toISOString(),
      }),
    )

    expect(getCapturedReferral()).toBeNull()
  })

  it('drops a malformed stored value rather than sending it', () => {
    window.localStorage.setItem(KEY, 'not json')
    expect(getCapturedReferral()).toBeNull()

    window.localStorage.setItem(KEY, JSON.stringify({ code: 'ok-0001' }))
    expect(getCapturedReferral()).toBeNull()
  })
})

describe('clearing', () => {
  it('forgets a spent code, so a second signup in the same browser cannot reuse it', () => {
    captureReferralCode('?ref=k7m2q9')

    clearCapturedReferral()

    expect(getCapturedReferral()).toBeNull()
  })
})

describe('when storage is unavailable', () => {
  it('costs the attribution and nothing else', () => {
    const throwing = () => {
      throw new Error('storage disabled')
    }
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(throwing)
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(throwing)
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(throwing)

    // A signup must never fail because a referral could not be remembered.
    expect(() => captureReferralCode('?ref=k7m2q9')).not.toThrow()
    expect(getCapturedReferral()).toBeNull()
    expect(() => clearCapturedReferral()).not.toThrow()
  })
})
