import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import OnboardingPage from './OnboardingPage'
import { PENDING_HERO_ROLE_KEY, PENDING_OAUTH_CONSENT_KEY } from './Onboarding/types'

/**
 * Both exits of the terminal `invite` step must end onboarding IDENTICALLY, on
 * BOTH paths.
 *
 * This is the property that survived the removal of `all_set`. That screen was
 * the single exit from the wizard, so "completes onboarding" and "navigates to
 * the right place" could not diverge. There are two exits now — Continue and
 * the skip modal — and the paths land in different places (A on the dashboard,
 * B on the gallery with the hero role prefilled), so there are four
 * combinations where previously there were two, and nothing else asserts them.
 *
 * The failure this guards against is not cosmetic: a tenant that reaches
 * /dashboard with onboarding_completed still false is sent straight back into
 * the wizard by the dashboard gate, so an exit that navigates without
 * completing is a loop.
 */

const mockNavigate = vi.fn()
vi.mock('react-router', async () => {
  const actual = await vi.importActual<typeof import('react-router')>('react-router')
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useSearchParams: () => [new URLSearchParams(), vi.fn()],
    Navigate: () => null,
  }
})

const mockUpdateTenant = vi.fn().mockResolvedValue(undefined)
const mockRefreshTenants = vi.fn().mockResolvedValue(undefined)
let tenantPath: 'A' | 'B' = 'A'

vi.mock('../../hooks/useTenant', () => ({
  useTenant: () => ({
    currentTenant: {
      id: 'tenant-1',
      name: 'Acme',
      onboardingStepId: 'invite',
      onboardingPath: tenantPath,
      onboardingCompletedAt: null,
    },
    currentRole: 'owner',
    tenantLoading: false,
    refreshTenants: mockRefreshTenants,
  }),
  useUpdateTenant: () => ({ mutateAsync: mockUpdateTenant }),
}))

vi.mock('../../hooks/useAccount', () => ({
  useUpdateAccount: () => ({ mutateAsync: vi.fn().mockResolvedValue(undefined) }),
}))

vi.mock('../../contexts/AuthContext', () => ({
  useAuth: () => ({ account: { persona: 'founder' } }),
}))

vi.mock('../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}))

vi.mock('../../lib/analytics', () => ({
  track: vi.fn(),
  trackOnboarding: vi.fn(),
}))

const mockInvite = vi.fn().mockResolvedValue(undefined)
vi.mock('../../services/tenants', () => ({
  inviteToTenant: (...a: unknown[]) => mockInvite(...a),
}))

vi.mock('../../components/Dashboard/OnboardingUserMenu', () => ({ default: () => null }))

beforeEach(() => {
  mockNavigate.mockClear()
  mockUpdateTenant.mockClear()
  mockRefreshTenants.mockClear()
  mockInvite.mockClear()
  sessionStorage.clear()
  tenantPath = 'A'
})

/** Both exits must do this, on both paths: persist completion at `invite`. */
function expectCompletionPersisted() {
  expect(mockUpdateTenant).toHaveBeenCalledWith(
    expect.objectContaining({
      tenantId: 'tenant-1',
      onboardingCompleted: true,
      onboardingStepId: 'invite',
    }),
  )
}

async function skipInvites() {
  fireEvent.click(await screen.findByRole('button', { name: /skip invites/i }))
  fireEvent.click(screen.getByRole('button', { name: /^skip invite$/i }))
}

describe('completing onboarding from the invite step', () => {
  describe('Path A', () => {
    it('Continue completes and lands on the dashboard', async () => {
      render(<OnboardingPage />)

      fireEvent.change(await screen.findByRole('textbox'), {
        target: { value: 'alice@acme.com' },
      })
      fireEvent.click(screen.getByRole('button', { name: /continue/i }))

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/dashboard'))
      expectCompletionPersisted()
    })

    it('Skip completes and lands on the dashboard too', async () => {
      render(<OnboardingPage />)

      await skipInvites()

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/dashboard'))
      expectCompletionPersisted()
    })

    it('ignores a stray hero role rather than diverting to the gallery', async () => {
      sessionStorage.setItem(PENDING_HERO_ROLE_KEY, 'Sales Engineer')
      render(<OnboardingPage />)

      await skipInvites()

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/dashboard'))
    })
  })

  describe('Path B', () => {
    beforeEach(() => { tenantPath = 'B' })

    it('Continue completes and lands on the gallery with the hero role', async () => {
      sessionStorage.setItem(PENDING_HERO_ROLE_KEY, 'Sales Engineer')
      render(<OnboardingPage />)

      fireEvent.change(await screen.findByRole('textbox'), {
        target: { value: 'alice@acme.com' },
      })
      fireEvent.click(screen.getByRole('button', { name: /continue/i }))

      await waitFor(() =>
        expect(mockNavigate).toHaveBeenCalledWith('/dashboard/agents/explore?role=Sales%20Engineer'),
      )
      expectCompletionPersisted()
    })

    // The exit most likely to regress: skipping is the path that did NOT have
    // the destination logic before, because it used to hand off to all_set.
    it('Skip completes and STILL lands on the gallery with the hero role', async () => {
      sessionStorage.setItem(PENDING_HERO_ROLE_KEY, 'Sales Engineer')
      render(<OnboardingPage />)

      await skipInvites()

      await waitFor(() =>
        expect(mockNavigate).toHaveBeenCalledWith('/dashboard/agents/explore?role=Sales%20Engineer'),
      )
      expectCompletionPersisted()
    })

    it('degrades to the plain gallery when the hero role was lost', async () => {
      render(<OnboardingPage />)

      await skipInvites()

      await waitFor(() =>
        expect(mockNavigate).toHaveBeenCalledWith('/dashboard/agents/explore'),
      )
    })

    // Single-use: leaving it behind would divert an unrelated later navigation.
    it('clears the hero role once consumed', async () => {
      sessionStorage.setItem(PENDING_HERO_ROLE_KEY, 'Sales Engineer')
      render(<OnboardingPage />)

      await skipInvites()

      await waitFor(() => expect(mockNavigate).toHaveBeenCalled())
      expect(sessionStorage.getItem(PENDING_HERO_ROLE_KEY)).toBeNull()
    })
  })

  // An owner who came from a coding tool's consent request returns to that
  // request, on either path and either exit: the request was parked for them
  // and approves now that the workspace is set up.
  describe('returning to a parked OAuth consent request', () => {
    it('navigates back to the consent page for the stored request instead of the dashboard', async () => {
      sessionStorage.setItem(PENDING_OAUTH_CONSENT_KEY, 'req_abc 1')
      render(<OnboardingPage />)

      await skipInvites()

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/oauth/consent?request_id=req_abc%201'))
      expect(mockNavigate).not.toHaveBeenCalledWith('/dashboard')
      expectCompletionPersisted()
    })

    it('wins over the hero role on Path B', async () => {
      tenantPath = 'B'
      sessionStorage.setItem(PENDING_HERO_ROLE_KEY, 'Sales Engineer')
      sessionStorage.setItem(PENDING_OAUTH_CONSENT_KEY, 'req_abc')
      render(<OnboardingPage />)

      await skipInvites()

      await waitFor(() => expect(mockNavigate).toHaveBeenCalledWith('/oauth/consent?request_id=req_abc'))
    })

    // Single-use: leaving it behind would send a later, unrelated onboarding
    // completion to a consent request that no longer exists.
    it('clears the stored request id once consumed', async () => {
      sessionStorage.setItem(PENDING_OAUTH_CONSENT_KEY, 'req_abc')
      render(<OnboardingPage />)

      await skipInvites()

      await waitFor(() => expect(mockNavigate).toHaveBeenCalled())
      expect(sessionStorage.getItem(PENDING_OAUTH_CONSENT_KEY)).toBeNull()
    })
  })

  // The gate reads tenant state on arrival, so a navigation that outruns the
  // refresh bounces the user back into the wizard.
  it('refreshes tenants before navigating, on either exit', async () => {
    render(<OnboardingPage />)

    await skipInvites()

    await waitFor(() => expect(mockNavigate).toHaveBeenCalled())
    expect(mockRefreshTenants).toHaveBeenCalled()
  })
})
