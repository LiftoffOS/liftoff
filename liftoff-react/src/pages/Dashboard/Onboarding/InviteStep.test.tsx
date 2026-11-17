import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import InviteStep from './InviteStep'

/**
 * `invite` is the terminal step of the wizard, so BOTH of its exits end
 * onboarding: Continue (after the invites are sent) and the skip modal's
 * "Skip Invite". OnboardingPage wires both to the same `completeOnboarding`.
 *
 * These tests pin the half of that contract this component owns — that each
 * exit fires its own callback, and that skipping cannot happen without the
 * modal. Before `all_set` was retired there was one way out of the wizard and
 * it lived on its own screen; there are two now, and a regression that left
 * either one calling nothing would strand the user on the last step with no way
 * forward.
 */

const mockShowToast = vi.fn()
vi.mock('../../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mockShowToast }),
}))

vi.mock('../../../hooks/useTenant', () => ({
  useTenant: () => ({ currentTenant: { id: 'tenant-1' } }),
}))

const mockInvite = vi.fn().mockResolvedValue(undefined)
vi.mock('../../../services/tenants', () => ({
  inviteToTenant: (...a: unknown[]) => mockInvite(...a),
}))

function setup(overrides: Partial<React.ComponentProps<typeof InviteStep>> = {}) {
  const onFinish = vi.fn()
  const onSkip = vi.fn()
  render(
    <InviteStep
      workspaceName="Acme"
      emailsRaw=""
      onEmailsChange={() => {}}
      onFinish={onFinish}
      onSkip={onSkip}
      previewMode={false}
      {...overrides}
    />,
  )
  return { onFinish, onSkip }
}

beforeEach(() => {
  mockShowToast.mockClear()
  mockInvite.mockClear()
})

describe('InviteStep — the wizard ends here', () => {
  it('Continue sends the invites and then ends onboarding', async () => {
    const { onFinish, onSkip } = setup({ emailsRaw: 'alice@acme.com, ben@acme.com' })

    fireEvent.click(screen.getByRole('button', { name: /continue/i }))

    await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1))
    expect(mockInvite).toHaveBeenCalledTimes(2)
    expect(onSkip).not.toHaveBeenCalled()
  })

  it('Continue is disabled until at least one address parses', () => {
    setup({ emailsRaw: 'not-an-email' })
    expect(screen.getByRole('button', { name: /continue/i })).toBeDisabled()
  })

  // Inviting colleagues is the point of the step, so a mis-click must not end
  // the wizard. The modal is the confirmation.
  it('Skip Invites opens the modal rather than ending onboarding directly', () => {
    const { onSkip } = setup()

    fireEvent.click(screen.getByRole('button', { name: /skip invites/i }))

    expect(screen.getByText(/skip without inviting\?/i)).toBeInTheDocument()
    expect(onSkip).not.toHaveBeenCalled()
  })

  it("the modal's Skip Invite ends onboarding", () => {
    const { onFinish, onSkip } = setup()

    fireEvent.click(screen.getByRole('button', { name: /skip invites/i }))
    fireEvent.click(screen.getByRole('button', { name: /^skip invite$/i }))

    expect(onSkip).toHaveBeenCalledTimes(1)
    expect(onFinish).not.toHaveBeenCalled()
  })

  it('cancelling the modal ends nothing and leaves the user on the step', () => {
    const { onFinish, onSkip } = setup()

    fireEvent.click(screen.getByRole('button', { name: /skip invites/i }))
    fireEvent.click(screen.getByRole('button', { name: /cancel/i }))

    expect(onSkip).not.toHaveBeenCalled()
    expect(onFinish).not.toHaveBeenCalled()
  })

  // A partial failure still advances: the invites that landed are real, and
  // holding the user here would not un-send them.
  it('ends onboarding even when some invites fail', async () => {
    mockInvite
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('nope'))
    const { onFinish } = setup({ emailsRaw: 'alice@acme.com, ben@acme.com' })

    fireEvent.click(screen.getByRole('button', { name: /continue/i }))

    await waitFor(() => expect(onFinish).toHaveBeenCalledTimes(1))
    expect(mockShowToast).toHaveBeenCalledWith(expect.stringMatching(/could not be sent/i), 'error')
  })

  // Every invite failing is the one case that must NOT end the wizard —
  // nothing was sent, so advancing would claim a success that did not happen.
  it('does NOT end onboarding when every invite fails', async () => {
    mockInvite.mockRejectedValue(new Error('nope'))
    const { onFinish } = setup({ emailsRaw: 'alice@acme.com' })

    fireEvent.click(screen.getByRole('button', { name: /continue/i }))

    await waitFor(() =>
      expect(mockShowToast).toHaveBeenCalledWith(expect.stringMatching(/could not send/i), 'error'),
    )
    expect(onFinish).not.toHaveBeenCalled()
  })
})
