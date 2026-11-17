import { useState } from 'react'
import Button from '../../../components/Button'
import ModalOverlay from '../../../components/ModalOverlay'
import { useTenant } from '../../../hooks/useTenant'
import { useToast } from '../../../contexts/ToastContext'
import { inviteToTenant } from '../../../services/tenants'

/**
 * Onboarding invite step. Recovered from the pre-fused-onboarding wizard
 * (commit 184b3a6, removed by 9de114f) and lifted out of OnboardingPage into
 * its own file to match the sibling steps.
 *
 * Behaviour is the original's: parse a comma/newline separated list, fire one
 * invite per address concurrently, and report partial failure honestly rather
 * than claiming success for the whole batch. The skip path asks for
 * confirmation once — inviting colleagues is the point of the step, so a
 * mis-click should not silently end it.
 *
 * Dev preview (`previewMode`) never POSTs: the same toast renders so the
 * wizard transitions look real, but no invitation email is sent.
 */
interface Props {
  workspaceName: string
  emailsRaw: string
  onEmailsChange: (v: string) => void
  onFinish: () => void
  onSkip: () => void
  previewMode: boolean
}

export default function InviteStep({
  workspaceName,
  emailsRaw,
  onEmailsChange,
  onFinish,
  onSkip,
  previewMode,
}: Props) {
  const { currentTenant } = useTenant()
  const { showToast } = useToast()
  const [sending, setSending] = useState(false)
  const [showSkipModal, setShowSkipModal] = useState(false)

  const trimmedName = workspaceName.trim()
  const possessive = trimmedName
    ? `${trimmedName}${trimmedName.endsWith('s') ? "'" : "'s"}`
    : 'your'
  const parsedEmails = parseInviteEmails(emailsRaw)
  const canContinue = parsedEmails.length > 0

  const handleSendInvites = async () => {
    if (parsedEmails.length === 0) return
    // Dev preview: never actually POST invitations. Show the same toast so
    // the wizard transitions look real, then advance.
    if (previewMode) {
      setSending(true)
      showToast(
        `Invited ${parsedEmails.length} ${parsedEmails.length === 1 ? 'teammate' : 'teammates'} (preview)`,
        'success',
      )
      onFinish()
      return
    }
    if (!currentTenant?.id) return
    setSending(true)
    const tenantId = currentTenant.id
    const results = await Promise.allSettled(
      parsedEmails.map((email) => inviteToTenant(tenantId, email, 'member')),
    )
    const fulfilled = results.filter((r) => r.status === 'fulfilled').length
    const rejected = results.length - fulfilled

    if (fulfilled > 0 && rejected === 0) {
      showToast(
        `Invited ${fulfilled} ${fulfilled === 1 ? 'teammate' : 'teammates'}`,
        'success',
      )
      onFinish()
      return
    }
    // Partial success still advances — the invites that landed are real, and
    // holding the user on this screen would not un-send them.
    if (fulfilled > 0 && rejected > 0) {
      showToast(
        `Invited ${fulfilled}; ${rejected} could not be sent`,
        'error',
      )
      onFinish()
      return
    }
    showToast('Could not send invitations. Please try again.', 'error')
    setSending(false)
  }

  return (
    <div className="onboarding__content">
      <div className="onboarding__heading">
        <h1 className="onboarding__title">Who else is on {possessive} team?</h1>
        <p className="onboarding__subtitle">Add coworker by email</p>
      </div>
      <textarea
        className="onboarding-invites__textarea"
        placeholder="E.g. alice@acme.com, ben@acme.com"
        value={emailsRaw}
        onChange={(e) => onEmailsChange(e.target.value)}
        rows={4}
        disabled={sending}
      />
      <div className="onboarding__actions">
        <Button variant="outline" onClick={() => setShowSkipModal(true)} disabled={sending}>
          Skip Invites
        </Button>
        <Button
          variant="primary"
          onClick={handleSendInvites}
          disabled={!canContinue || sending}
          loading={sending}
        >
          Continue
        </Button>
      </div>
      {showSkipModal && (
        <ModalOverlay
          onClose={() => setShowSkipModal(false)}
          ariaLabelledBy="onboarding-skip-modal-title"
        >
          <h2 id="onboarding-skip-modal-title" className="onboarding-skip-modal__title">
            Skip Without Inviting?
          </h2>
          <p className="onboarding-skip-modal__description">
            Invite your colleagues so more people can start putting AI to work for them.
          </p>
          <div className="onboarding-skip-modal__actions">
            <Button variant="outline" onClick={() => setShowSkipModal(false)}>
              Cancel
            </Button>
            <Button variant="primary" onClick={onSkip}>
              Skip Invite
            </Button>
          </div>
        </ModalOverlay>
      )}
    </div>
  )
}

// Parses a comma- and/or newline-separated list of email addresses and returns
// only the ones that look syntactically valid. Used to gate the Continue button
// and to drive the invite-sending call.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
function parseInviteEmails(raw: string): string[] {
  return raw
    .split(/[,\n]/)
    .map((s) => s.trim())
    .filter((s) => EMAIL_RE.test(s))
}
