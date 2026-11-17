// The banner is the only thing standing between an operator and forgetting
// whose account they are typing into, and a support session can write. So the
// tests are about when it appears, not about how it looks.

import { describe, it, expect, beforeEach, vi, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import DelegationBanner from './DelegationBanner'
import { setDelegation } from '../lib/supportDelegation'

const mockEndSession = vi.fn()
vi.mock('../services/supportDelegation', () => ({
  endDelegationSession: (...args: unknown[]) => mockEndSession(...args),
}))

const session = (over: Partial<{ targetEmail: string; sessionId: string }> = {}) => ({
  ticket: 'ticket-abc',
  targetEmail: 'paul.drummond@northwind.com',
  sessionId: 'sess-1',
  ...over,
})

describe('DelegationBanner', () => {
  beforeEach(() => {
    sessionStorage.clear()
    mockEndSession.mockReset().mockResolvedValue(undefined)
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('renders nothing in an ordinary tab', () => {
    const { container } = render(<DelegationBanner />)
    expect(container).toBeEmptyDOMElement()
  })

  it('names the person whose account this is, and says writes will land on it', () => {
    setDelegation(session())
    render(<DelegationBanner />)

    expect(screen.getByText('paul.drummond@northwind.com')).toBeInTheDocument()
    expect(screen.getByText(/saved to their account/i)).toBeInTheDocument()
  })

  it('shows no countdown, because sessions do not expire', () => {
    setDelegation(session())
    render(<DelegationBanner />)
    expect(screen.queryByText(/minutes? left|hours? left|expired/i)).not.toBeInTheDocument()
  })

  it('ends the grant server-side on Exit, not just locally', async () => {
    // Exit used to only clear sessionStorage. The grant stayed open with no
    // expiry, and the actUrl in browser history could resurrect it — so a
    // button everyone reads as "end this" ended nothing on the server.
    const assign = vi.fn()
    vi.stubGlobal('location', { assign } as unknown as Location)

    setDelegation(session())
    render(<DelegationBanner />)
    await userEvent.click(screen.getByRole('button', { name: 'Exit' }))

    await waitFor(() => expect(mockEndSession).toHaveBeenCalledWith('sess-1'))
  })

  it('clears locally FIRST, so the revoke is made as the operator and a failure cannot trap them', async () => {
    // The admin route that ends a grant is on the delegation deny list, so a
    // request still carrying the act-as header would be refused with 403.
    const assign = vi.fn()
    vi.stubGlobal('location', { assign } as unknown as Location)
    let clearedBeforeRevoke: boolean | null = null
    mockEndSession.mockImplementation(() => {
      clearedBeforeRevoke = sessionStorage.getItem('liftoff_support_delegation') === null
      // endDelegationSession swallows its own errors; this stands in for that
      // contract rather than leaking an unhandled rejection into the test.
      return Promise.resolve()
    })

    setDelegation(session())
    render(<DelegationBanner />)
    await userEvent.click(screen.getByRole('button', { name: 'Exit' }))

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/dashboard'))
    expect(clearedBeforeRevoke).toBe(true)
    expect(sessionStorage.getItem('liftoff_support_delegation')).toBeNull()
  })

  it('still exits cleanly for a session stored before sessionId was recorded', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { assign } as unknown as Location)

    setDelegation({ ticket: 'ticket-abc', targetEmail: 'paul.drummond@northwind.com' })
    render(<DelegationBanner />)
    await userEvent.click(screen.getByRole('button', { name: 'Exit' }))

    await waitFor(() => expect(assign).toHaveBeenCalledWith('/dashboard'))
    expect(mockEndSession).not.toHaveBeenCalled()
  })

  it('clears the session on Exit and reloads, so no operator state survives the switch back', async () => {
    const assign = vi.fn()
    vi.stubGlobal('location', { assign } as unknown as Location)

    setDelegation(session())
    render(<DelegationBanner />)

    await userEvent.click(screen.getByRole('button', { name: 'Exit' }))

    expect(sessionStorage.getItem('liftoff_support_delegation')).toBeNull()
    expect(assign).toHaveBeenCalledWith('/dashboard')
  })

  it('renders in a tab that inherited the session rather than being handed props', () => {
    // Browsers copy sessionStorage into a tab opened from the current one, so a
    // cmd-clicked link lands in a delegated tab that nobody told about it.
    setDelegation(session())
    render(<DelegationBanner />)
    expect(screen.getByRole('status')).toBeInTheDocument()
  })
})
