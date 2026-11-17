import { describe, it, expect } from 'vitest'
import {
  isBrowserPaneAvailable,
  SESSION_BROWSER_CONNECTORS,
  shouldClosePaneOnThreadChange,
} from './browserPaneAvailability'

const active = (type: string) => ({ type, status: 'active' })

describe('browser pane availability', () => {
  it('offers the pane for an Anchor-bound agent', () => {
    expect(isBrowserPaneAvailable(['anchor_browser'], [active('anchor_browser')])).toBe(true)
  })

  it('offers the pane for a Browser Use-bound agent', () => {
    // The regression this file exists for. Browser Use shipped end to end in the
    // runtime while this gate still named anchor_browser, so a correctly bound
    // agent had a working browser and no button to open it.
    expect(isBrowserPaneAvailable(['browser_use'], [active('browser_use')])).toBe(true)
  })

  it('withholds it when the agent is not bound, even if the tenant connected one', () => {
    // Tenant connection alone over-promises: the affordance would appear for an
    // agent that cannot browse, and asking it to navigate gets a persona refusal.
    expect(isBrowserPaneAvailable(['gmail'], [active('browser_use')])).toBe(false)
  })

  it('withholds it when bound but the connector is not active', () => {
    // No credential means no session can start, so a button would do nothing.
    expect(isBrowserPaneAvailable(['browser_use'], [{ type: 'browser_use', status: 'error' }])).toBe(false)
  })

  it('offers it for browserbase, which now drives the pane', () => {
    // It reported session support for a long time while implementing one of the
    // ten pane operations, so offering the affordance would have opened a
    // browser that accepted commands and did nothing. It implements all ten now.
    expect(isBrowserPaneAvailable(['browserbase'], [active('browserbase')])).toBe(true)
  })

  it('offers it when the bound vendor and the active vendor differ', () => {
    // The runtime picks by preference order, so either being available is enough.
    expect(isBrowserPaneAvailable(['anchor_browser', 'browser_use'], [active('browser_use')])).toBe(true)
  })

  it('handles an agent with no integrations at all', () => {
    expect(isBrowserPaneAvailable([], [active('anchor_browser')])).toBe(false)
  })

  it('keeps the list in step with the runtime preference order', () => {
    // If this fails, session-vendor-proxy.ts gained or lost a session vendor and
    // this gate was not updated — the exact drift that hid the button.
    expect([...SESSION_BROWSER_CONNECTORS]).toEqual(['anchor_browser', 'browserbase', 'steel', 'browser_use'])
  })
})

describe('closing the pane on a thread change', () => {
  it('closes when moving between two different conversations', () => {
    expect(shouldClosePaneOnThreadChange('thread-a', 'thread-b')).toBe(true)
  })

  it('does NOT close when the first thread is created', () => {
    // The flicker regression: pressing the browser toggle on a chat with no
    // thread opens the pane, then creates a thread (null -> id). Treating that
    // as a switch closed the pane a frame later, and the session arriving
    // reopened it — open, close, open.
    expect(shouldClosePaneOnThreadChange(null, 'thread-a')).toBe(false)
  })

  it('does not close when the id is unchanged', () => {
    expect(shouldClosePaneOnThreadChange('thread-a', 'thread-a')).toBe(false)
  })

  it('does not close when the thread goes away', () => {
    // Nothing to switch TO; leaving the pane alone avoids a flash on teardown.
    expect(shouldClosePaneOnThreadChange('thread-a', null)).toBe(false)
  })
})

describe('the platform browser, which every workspace has', () => {
  it('offers the pane to an agent bound to no browser connector at all', () => {
    // The whole point of the platform key. Requiring a connector here gated the
    // toggle AND the pane render, so an agent would drive a browser nobody
    // could open or watch.
    expect(isBrowserPaneAvailable(['gmail'], [], true)).toBe(true)
  })

  it('offers it to a workspace with no connectors whatsoever', () => {
    expect(isBrowserPaneAvailable([], [], true)).toBe(true)
  })

  it('withdraws it when an operator switches the platform browser off', () => {
    // A toggle that opens a browser the backend then refuses is the same broken
    // affordance as no toggle.
    expect(isBrowserPaneAvailable(['gmail'], [], false)).toBe(false)
  })

  it("still offers it on the workspace's OWN connector when the platform tier is off", () => {
    // The two routes are independent: an operator killing the platform browser
    // must not take away a browser the workspace pays for itself.
    expect(isBrowserPaneAvailable(['browser_use'], [active('browser_use')], false)).toBe(true)
  })

  it('defaults to connector-only when the caller passes no platform answer', () => {
    // Back-compat for any call site that has not been given the flag yet: it
    // behaves exactly as it did before the platform key existed.
    expect(isBrowserPaneAvailable(['gmail'], [active('browser_use')])).toBe(false)
  })
})
