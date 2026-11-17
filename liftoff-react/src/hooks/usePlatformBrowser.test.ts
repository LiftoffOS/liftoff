import { describe, it, expect } from 'vitest'
import { platformBrowserFromFlags } from './usePlatformBrowser'

describe('reading the platform browser out of the flag set', () => {
  it('is ON when neither switch has ever been set', () => {
    // The load-bearing case. The runtime defaults an unset vendor flag to
    // enabled, and flags only exist as rows once an operator makes one, so
    // defaulting to off here would hide the browser from every workspace until
    // somebody happened to create a flag nobody needs.
    expect(platformBrowserFromFlags({})).toBe(true)
  })

  it('is OFF only when EVERY platform vendor is switched off estate-wide', () => {
    // Two platform vendors back the pane (Steel first, Browser Use behind
    // it), and the runtime serves whichever is on, so one switch down still
    // leaves a browser.
    expect(platformBrowserFromFlags({ web_fetch_vendor_steel: false })).toBe(true)
    expect(platformBrowserFromFlags({ web_fetch_vendor_browser_use: false })).toBe(true)
    expect(
      platformBrowserFromFlags({ web_fetch_vendor_steel: false, web_fetch_vendor_browser_use: false }),
    ).toBe(false)
  })

  it('is OFF for a workspace an operator excluded from every platform vendor', () => {
    expect(
      platformBrowserFromFlags({ web_fetch_vendor_steel_disabled: true }),
    ).toBe(true)
    expect(
      platformBrowserFromFlags({
        web_fetch_vendor_steel_disabled: true,
        web_fetch_vendor_browser_use_disabled: true,
      }),
    ).toBe(false)
  })

  it('is OFF when one vendor is killed estate-wide and the other excluded here', () => {
    expect(
      platformBrowserFromFlags({
        web_fetch_vendor_steel: false,
        web_fetch_vendor_browser_use_disabled: true,
      }),
    ).toBe(false)
  })

  it('is ON when the flags exist and say yes', () => {
    expect(
      platformBrowserFromFlags({
        web_fetch_vendor_browser_use: true,
        web_fetch_vendor_browser_use_disabled: false,
      }),
    ).toBe(true)
  })

  it('is OFF while the flags have not loaded', () => {
    // Showing the affordance and withdrawing it a moment later is worse than
    // showing it a moment late.
    expect(platformBrowserFromFlags(undefined)).toBe(false)
  })
})
