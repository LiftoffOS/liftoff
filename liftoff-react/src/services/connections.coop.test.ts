import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const postMock = vi.fn()

vi.mock('./api', () => ({
  api: {
    post: (...args: unknown[]) => postMock(...args),
  },
}))

import { startOAuthFlow } from './connections'

// `popup.closed` stops meaning "closed" the moment a popup navigates to a
// provider that sends Cross-Origin-Opener-Policy: same-origin. Chromium severs
// the opener and reports the live window as closed. Stripe's authorize page
// does this, and it cost a real connection: the poll fired ~500ms in, resolved
// `popup_closed`, and cleanup() closed the BroadcastChannel about a hundred
// seconds before the genuine success broadcast arrived. The server had
// connected fine both times; the dashboard showed nothing at all, because a
// sub-15s "close" is deliberately read as the user changing their mind.
//
// So: a close seen within COOP_SEVERED_MS of opening is the opener being
// severed, not a person, and the signal must be discarded.
describe('startOAuthFlow — a COOP-severed popup is not a closed popup', () => {
  let popup: { closed: boolean; close: ReturnType<typeof vi.fn> }

  beforeEach(() => {
    vi.useFakeTimers()
    postMock.mockReset()
    postMock.mockResolvedValue({ authUrl: 'https://access.stripe.com/mcp/oauth2/authorize', state: 'st' })
    popup = { closed: false, close: vi.fn() }
    vi.stubGlobal('open', vi.fn(() => popup))
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('does not resolve when the popup reads closed immediately (COOP severance)', async () => {
    const { promise } = startOAuthFlow('stripe', 't1', 'tok')
    await vi.advanceTimersByTimeAsync(0)

    // The provider's COOP header makes this read true while the window lives.
    popup.closed = true
    await vi.advanceTimersByTimeAsync(3_000)

    let settled = false
    void promise.then(() => { settled = true })
    await vi.advanceTimersByTimeAsync(0)
    expect(settled).toBe(false)
  })

  it('still reports a genuine close once the user has had time to act', async () => {
    const { promise } = startOAuthFlow('stripe', 't1', 'tok')
    await vi.advanceTimersByTimeAsync(0)

    // Popup alive well past the severance window, then really closed.
    await vi.advanceTimersByTimeAsync(10_000)
    popup.closed = true
    await vi.advanceTimersByTimeAsync(1_000)

    await expect(promise).resolves.toMatchObject({ success: false, error: 'popup_closed' })
  })

  it('settles an abandoned COOP flow at the backstop instead of hanging', async () => {
    // Without the poll there is nothing else to settle the promise, and the
    // Connect button would spin forever.
    const { promise } = startOAuthFlow('stripe', 't1', 'tok')
    await vi.advanceTimersByTimeAsync(0)
    popup.closed = true
    await vi.advanceTimersByTimeAsync(3_000)

    await vi.advanceTimersByTimeAsync(5 * 60_000)
    await expect(promise).resolves.toMatchObject({ success: false, error: 'popup_closed' })
  })

  it('lets the success broadcast win long after the popup reads closed', async () => {
    const { promise } = startOAuthFlow('stripe', 't1', 'tok')
    await vi.advanceTimersByTimeAsync(0)
    popup.closed = true
    await vi.advanceTimersByTimeAsync(3_000)

    // 100 seconds later the user finishes authorising and the callback page
    // broadcasts. Before this fix the channel had been closed 99 seconds ago.
    await vi.advanceTimersByTimeAsync(100_000)
    const channel = new BroadcastChannel('oauth_callback')
    channel.postMessage({ type: 'oauth_callback', success: true, connectorType: 'stripe', connectorId: 'c-1' })
    channel.close()
    await vi.advanceTimersByTimeAsync(50)

    await expect(promise).resolves.toMatchObject({ success: true, connectorType: 'stripe', connectorId: 'c-1' })
  })
})
