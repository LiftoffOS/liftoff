// The /activate page: the browser step of the device flow (RFC 8628).
//
// The field takes any eight letters or digits and prints them XXXX-XXXX; the
// server is the one that says whether a code is known. A wrong, expired or
// rate-limited code is a toast with the field left in place, the way the
// connector pages report a bad key. A known code shows the same consent as
// /oauth/consent with the code under the subtext so the person can compare
// it with what their tool shows. Approval ends on a done state: nothing is
// redirected, the tool is polling. An owner mid-onboarding is sent to set up
// with the code remembered for the way back, and nothing is parked.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import ActivatePage from './ActivatePage'
import { PENDING_DEVICE_ACTIVATION_KEY } from './Dashboard/Onboarding/types'

const mockNavigate = vi.fn()
let search = ''
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useSearchParams: () => [new URLSearchParams(search), vi.fn()],
  }
})

let tenants: Array<{ id: string; name: string; role: string; onboardingCompletedAt: string | null }> = []
const mockSwitchTenant = vi.fn()
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ tenants, tenantLoading: false, switchTenant: mockSwitchTenant }),
}))

const mockShowToast = vi.fn()
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

vi.mock('../lib/analytics', () => ({ track: vi.fn() }))

const mockLookup = vi.fn()
const mockDecide = vi.fn()
vi.mock('../services/oauthConsent', () => ({
  lookupDeviceCode: (...args: unknown[]) => mockLookup(...args),
  submitDeviceDecision: (...args: unknown[]) => mockDecide(...args),
}))

class FakeApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

const CODEX = { clientName: 'Codex', clientSlug: 'codex', clientLabel: 'Codex', expiresAt: new Date(Date.now() + 600_000).toISOString() }
const READY = { id: 'tenant-2', name: 'Liftoff OS, Inc.', role: 'member', onboardingCompletedAt: '2026-01-01T00:00:00Z' }
const UNFINISHED = { id: 'tenant-1', name: 'My Workspace', role: 'owner', onboardingCompletedAt: null }

beforeEach(() => {
  mockNavigate.mockClear()
  mockShowToast.mockClear()
  mockSwitchTenant.mockReset()
  mockLookup.mockReset()
  mockDecide.mockReset()
  sessionStorage.clear()
  search = ''
  tenants = [READY]
})

describe('ActivatePage — entering the code', () => {
  it('formats whatever is typed as XXXX-XXXX, letters and digits only, and enables Continue at eight', () => {
    render(<ActivatePage />)
    const field = screen.getByLabelText('Code') as HTMLInputElement
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()

    fireEvent.change(field, { target: { value: 'dmc d-xk' } })
    expect(field.value).toBe('DMCD-XK')
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()

    // Vowels and digits are not dropped: the server judges the code.
    fireEvent.change(field, { target: { value: 'abcd 12 34 extra' } })
    expect(field.value).toBe('ABCD-1234')
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()
    expect(mockLookup).not.toHaveBeenCalled()
  })

  it('a complete code in the address is looked up on arrival, and the consent shows the code to compare', async () => {
    search = 'code=dmcd-xkpt'
    mockLookup.mockResolvedValueOnce(CODEX)
    render(<ActivatePage />)
    await waitFor(() => expect(mockLookup).toHaveBeenCalledWith('DMCD-XKPT'))
    expect(await screen.findByText('Code DMCD-XKPT')).toBeInTheDocument()
    expect(screen.getByText('Liftoff OS, Inc.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeEnabled()
    expect(mockLookup).toHaveBeenCalledTimes(1)
  })

  it('a wrong, expired or rate-limited code is a toast, with the field and its value kept for the retry', async () => {
    render(<ActivatePage />)
    const field = screen.getByLabelText('Code') as HTMLInputElement
    fireEvent.change(field, { target: { value: 'DMCDXKPT' } })

    mockLookup.mockRejectedValueOnce(new FakeApiError('code_not_found', 404))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Code not recognized. Check the code your coding tool shows.', 'error'))
    expect((screen.getByLabelText('Code') as HTMLInputElement).value).toBe('DMCD-XKPT')
    expect(screen.getByRole('button', { name: 'Continue' })).toBeEnabled()

    mockLookup.mockRejectedValueOnce(new FakeApiError('code_expired', 410))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('That code has expired. Ask your coding tool for a new one.', 'error'))

    mockLookup.mockRejectedValueOnce(new FakeApiError('rate_limited', 429))
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }))
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('Too many attempts. Wait a minute and try again.', 'error'))
    expect(screen.queryByText(/Code Not Recognized|Code Expired/)).not.toBeInTheDocument()
  })
})

describe('ActivatePage — deciding', () => {
  async function arriveAtConsent() {
    search = 'code=DMCD-XKPT'
    mockLookup.mockResolvedValueOnce(CODEX)
    render(<ActivatePage />)
    await screen.findByText('Code DMCD-XKPT')
  }

  it('Approve sends the code and the chosen workspace, then ends on Connected with no redirect', async () => {
    await arriveAtConsent()
    mockDecide.mockResolvedValueOnce({ approved: true, workspaceName: 'Liftoff OS, Inc.' })
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(mockDecide).toHaveBeenCalledWith({ userCode: 'DMCD-XKPT', tenantId: 'tenant-2', approve: true }))
    expect(await screen.findByText('Connected')).toBeInTheDocument()
    // The workspace name already ends in a period; the sentence adds none.
    expect(screen.getByText('Codex is connected to Liftoff OS, Inc. You can return to your coding tool.')).toBeInTheDocument()
    expect(mockNavigate).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Go to Dashboard' }))
    expect(mockNavigate).toHaveBeenCalledWith('/dashboard/agents')
  })

  it('Deny sends no workspace and ends on Not Connected', async () => {
    await arriveAtConsent()
    mockDecide.mockResolvedValueOnce({ approved: false })
    fireEvent.click(screen.getByRole('button', { name: 'Deny' }))
    await waitFor(() => expect(mockDecide).toHaveBeenCalledWith({ userCode: 'DMCD-XKPT', approve: false }))
    expect(await screen.findByText('Not Connected')).toBeInTheDocument()
    expect(screen.getByText('Codex was not connected. You can close this page.')).toBeInTheDocument()
  })

  it('a code that expired between lookup and Approve goes back to the field with the expired toast', async () => {
    await arriveAtConsent()
    mockDecide.mockRejectedValueOnce(new FakeApiError('code_expired', 410))
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    await waitFor(() => expect(mockShowToast).toHaveBeenCalledWith('That code has expired. Ask your coding tool for a new one.', 'error'))
    expect(screen.getByLabelText('Code')).toBeInTheDocument()
  })

  it('a rate-limited decision stays on the consent with the retry line, and any other failure with a generic one', async () => {
    await arriveAtConsent()
    mockDecide.mockRejectedValueOnce(new FakeApiError('rate_limited', 429))
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(await screen.findByText('Too many attempts. Wait a minute and try again.')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Approve' })).toBeEnabled()

    mockDecide.mockRejectedValueOnce(new FakeApiError('server_error', 500))
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(await screen.findByText('Something went wrong. Try again.')).toBeInTheDocument()
  })

  it('an owner whose workspace is not set up goes to onboarding with the code remembered, and nothing is parked', async () => {
    tenants = [UNFINISHED]
    await arriveAtConsent()
    expect(screen.queryByRole('button', { name: 'Approve' })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue Setup' }))
    expect(mockDecide).not.toHaveBeenCalled()
    expect(mockSwitchTenant).toHaveBeenCalledWith('tenant-1')
    expect(sessionStorage.getItem(PENDING_DEVICE_ACTIVATION_KEY)).toBe('DMCD-XKPT')
    expect(mockNavigate).toHaveBeenCalledWith('/onboarding')
  })

  it('the server applies the same rule on Approve: a 409 shows the setup state, whose Continue Setup goes to onboarding', async () => {
    await arriveAtConsent()
    mockDecide.mockRejectedValueOnce(new FakeApiError('setup_required', 409))
    fireEvent.click(screen.getByRole('button', { name: 'Approve' }))
    expect(await screen.findByText('Finish Setting Up Your Workspace')).toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Continue Setup' }))
    expect(mockSwitchTenant).toHaveBeenCalledWith('tenant-2')
    expect(sessionStorage.getItem(PENDING_DEVICE_ACTIVATION_KEY)).toBe('DMCD-XKPT')
    expect(mockNavigate).toHaveBeenCalledWith('/onboarding')
  })
})
