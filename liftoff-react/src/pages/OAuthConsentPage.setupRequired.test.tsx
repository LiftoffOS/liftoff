// The consent page and a workspace of the person's own that is not set up.
//
// Such a workspace is listed like the rest, flagged "Finish setup to connect", so
// the person can reach it from here; choosing it turns the primary action
// into Continue Setup, which parks the request server-side (so it is still
// live when they are back) and then goes to /onboarding. A brand-new person
// whose only workspace is unfinished sees the same picker with that one row
// selected and no Approve. A member of such a workspace connects as usual.
// The server applies the same rule on Approve (409), which shows the same
// setup state.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import OAuthConsentPage from './OAuthConsentPage'
import { PENDING_OAUTH_CONSENT_KEY } from './Dashboard/Onboarding/types'

const mockNavigate = vi.fn()
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useSearchParams: () => [new URLSearchParams('request_id=req_abc'), vi.fn()],
  }
})

let tenants: Array<{ id: string; name: string; role: string; onboardingCompletedAt: string | null }> = []
const mockSwitchTenant = vi.fn()
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ tenants, tenantLoading: false, switchTenant: mockSwitchTenant }),
}))

vi.mock('../lib/analytics', () => ({ track: vi.fn() }))

const mockSubmit = vi.fn()
const mockPark = vi.fn()
vi.mock('../services/oauthConsent', () => ({
  getOauthConsentRequest: vi.fn().mockResolvedValue({
    clientName: 'Claude Code', redirectHost: 'localhost', scope: 'mcp', expiresAt: new Date().toISOString(),
  }),
  parkOauthConsent: (...args: unknown[]) => mockPark(...args),
  submitOauthConsent: (...args: unknown[]) => mockSubmit(...args),
}))

class FakeApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

const UNFINISHED = { id: 'tenant-1', name: 'My Workspace', role: 'owner', onboardingCompletedAt: null }
const READY = { id: 'tenant-2', name: 'Acme', role: 'member', onboardingCompletedAt: '2026-01-01T00:00:00Z' }

beforeEach(() => {
  mockNavigate.mockClear()
  mockSubmit.mockReset()
  mockPark.mockReset()
  mockSwitchTenant.mockReset()
  sessionStorage.clear()
  tenants = [UNFINISHED]
})

describe('OAuthConsentPage — a workspace of their own that is not set up', () => {
  it('a new person: the one row, marked and selected; Continue Setup parks the request, then goes to onboarding', async () => {
    mockPark.mockResolvedValueOnce({ parked: true, onboardingUrl: '/onboarding' })
    render(<OAuthConsentPage />)

    expect(await screen.findByText('My Workspace')).toBeInTheDocument()
    expect(screen.getByText('· Finish setup to connect', { exact: false })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    // Deny pairs with Approve; there is nothing to deny yet.
    expect(screen.queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument()
    expect(mockPark).not.toHaveBeenCalled()

    fireEvent.click(screen.getByRole('button', { name: 'Continue Setup' }))
    await waitFor(() => expect(mockPark).toHaveBeenCalledWith({ requestId: 'req_abc', tenantId: 'tenant-1' }))
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/onboarding'))
    // Onboarding runs against the current workspace: the chosen one is made
    // current before the page leaves.
    expect(mockSwitchTenant).toHaveBeenCalledWith('tenant-1')
    expect(sessionStorage.getItem(PENDING_OAUTH_CONSENT_KEY)).toBe('req_abc')
    expect(mockSubmit).not.toHaveBeenCalled()
  })

  it('with another workspace that can be connected, the unfinished one is still listed: choosing it leads to setup, choosing the other to Approve', async () => {
    tenants = [READY, UNFINISHED]
    render(<OAuthConsentPage />)
    expect(await screen.findByText('Acme')).toBeInTheDocument()
    expect(screen.getByText('My Workspace')).toBeInTheDocument()
    // Nothing selected yet with two rows: Approve waits for a choice.
    expect(screen.getByRole('button', { name: 'Approve' })).toBeDisabled()

    fireEvent.click(screen.getByText('Acme'))
    expect(screen.queryByRole('button', { name: 'Continue Setup' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()

    fireEvent.click(screen.getByText('My Workspace'))
    expect(screen.getByRole('button', { name: 'Continue Setup' })).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Deny' })).not.toBeInTheDocument()
    mockPark.mockResolvedValueOnce({ parked: true, onboardingUrl: '/onboarding' })
    fireEvent.click(screen.getByRole('button', { name: 'Continue Setup' }))
    await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/onboarding'))
    // The unfinished one is parked and made current, not the one the app
    // happened to have current.
    expect(mockPark).toHaveBeenCalledWith({ requestId: 'req_abc', tenantId: 'tenant-1' })
    expect(mockSwitchTenant).toHaveBeenCalledWith('tenant-1')
  })

  it('a park that fails keeps them on the page with an error; an expired request shows the expired state, naming no terminal', async () => {
    mockPark.mockRejectedValueOnce(new FakeApiError('server_error', 500))
    render(<OAuthConsentPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Continue Setup' }))
    expect(await screen.findByText('Something went wrong. Try again.')).toBeInTheDocument()
    expect(mockNavigate).not.toHaveBeenCalled()
    expect(screen.getByRole('button', { name: 'Continue Setup' })).toBeEnabled()

    mockPark.mockRejectedValueOnce(new FakeApiError('request_expired', 410))
    fireEvent.click(screen.getByRole('button', { name: 'Continue Setup' }))
    expect(await screen.findByText('Request Expired')).toBeInTheDocument()
    expect(screen.getByText(/Go back to your coding tool and run the sign-in again/)).toBeInTheDocument()
    expect(screen.queryByText(/terminal/)).not.toBeInTheDocument()
  })

  it('a member of an unfinished workspace connects as usual', async () => {
    tenants = [{ ...UNFINISHED, role: 'member' }]
    mockSubmit.mockResolvedValueOnce({ redirectTo: 'http://localhost/cb' })
    render(<OAuthConsentPage />)
    expect(await screen.findByText('member')).toBeInTheDocument()
    expect(screen.queryByText(/Finish setup to connect/)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
  })

  it('the server applies the same rule on Approve: a 409 shows the setup state, whose Continue Setup goes straight to onboarding', async () => {
    tenants = [READY]
    mockSubmit.mockRejectedValueOnce(new FakeApiError('setup_required', 409))
    render(<OAuthConsentPage />)
    fireEvent.click(await screen.findByRole('button', { name: 'Approve' }))
    expect(await screen.findByText('Finish Setting Up Your Workspace')).toBeInTheDocument()
    expect(screen.queryByText(/not set up yet/)).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue Setup' }))
    expect(mockPark).not.toHaveBeenCalled()
    expect(mockSwitchTenant).toHaveBeenCalledWith('tenant-2')
    expect(mockNavigate).toHaveBeenCalledWith('/onboarding')
    expect(sessionStorage.getItem(PENDING_OAUTH_CONSENT_KEY)).toBe('req_abc')
  })
})
