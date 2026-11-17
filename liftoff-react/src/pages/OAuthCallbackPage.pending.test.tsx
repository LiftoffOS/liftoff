// The GitHub App install leg has a third outcome the callback page never had a
// concept of. When the person installing is not an owner of the organisation
// they chose, GitHub records a REQUEST and redirects back with `?pending=`.
//
// Falling through to the existing `success: false` branch would report it as a
// failed connection, which it is not; reporting it as success would claim an
// installation that does not exist.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, waitFor } from '@testing-library/react'
import OAuthCallbackPage from './OAuthCallbackPage'

function messagesOnChannel(): Array<Record<string, unknown>> {
  const received: Array<Record<string, unknown>> = []
  const listener = new BroadcastChannel('oauth_callback')
  listener.onmessage = (event) => { received.push(event.data) }
  channels.push(listener)
  return received
}

const channels: BroadcastChannel[] = []

beforeEach(() => {
  vi.spyOn(window, 'close').mockImplementation(() => {})
})

afterEach(() => {
  channels.splice(0).forEach((c) => c.close())
  vi.restoreAllMocks()
})

describe('OAuthCallbackPage — GitHub App install awaiting owner approval', () => {
  it('broadcasts a pending result carrying the organisation', async () => {
    const received = messagesOnChannel()
    window.history.replaceState({}, '', '/oauth/callback?pending=github&org=acme-corp&connectorId=c-1')

    render(<OAuthCallbackPage />)

    await waitFor(() => expect(received).toHaveLength(1))
    expect(received[0]).toMatchObject({
      type: 'oauth_callback',
      pending: true,
      connectorType: 'github',
      org: 'acme-corp',
      connectorId: 'c-1',
    })
    // Never success: nothing is installed until an owner approves.
    expect(received[0].success).toBe(false)
  })

  it('tells the user a request was sent, not that the connection completed', async () => {
    messagesOnChannel()
    window.history.replaceState({}, '', '/oauth/callback?pending=github&org=acme-corp')

    const { findByText } = render(<OAuthCallbackPage />)

    expect(await findByText(/Request sent to the organization owners/i)).toBeInTheDocument()
  })

  it('still reports an ordinary success as success', async () => {
    const received = messagesOnChannel()
    window.history.replaceState({}, '', '/oauth/callback?connected=github&connectorId=c-2')

    render(<OAuthCallbackPage />)

    await waitFor(() => expect(received).toHaveLength(1))
    expect(received[0]).toMatchObject({
      type: 'oauth_callback',
      success: true,
      connectorType: 'github',
      connectorId: 'c-2',
    })
    expect(received[0].pending).toBeUndefined()
  })

  it('still reports a failed install as a failure', async () => {
    const received = messagesOnChannel()
    window.history.replaceState({}, '', '/oauth/callback?error=github_install_failed')

    render(<OAuthCallbackPage />)

    await waitFor(() => expect(received).toHaveLength(1))
    expect(received[0]).toMatchObject({ success: false, error: 'github_install_failed' })
  })
})
