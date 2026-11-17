// Tests for ResponsibilitiesStep — the Continue gate accepts EITHER
// non-empty responsibilities text OR at least one attachment, so an
// upload-only user (no typed text) can still proceed.

import { render, screen, fireEvent } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import type { TeamAttachment } from '../../../../services/internalAgents'

vi.mock('../../../../components/ResponsibilitiesInput', () => ({
  default: () => null,
  stripTemplateIfUntouched: (v: string) => v,
}))
vi.mock('../../../../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}))

import ResponsibilitiesStep from './ResponsibilitiesStep'

const attachment: TeamAttachment = {
  kind: 'upload',
  name: 'skills.md',
  content: '# Skills',
  addedAt: '2026-01-01T00:00:00.000Z',
  source: 'responsibilities',
}

describe('ResponsibilitiesStep', () => {
  it('disables Continue with empty text and no attachments', () => {
    render(
      <ResponsibilitiesStep value="" onChange={() => {}} onContinue={() => {}} />,
    )
    expect(screen.getByRole('button', { name: 'Continue' })).toBeDisabled()
  })

  it('enables Continue with an attachment only and fires onContinue', () => {
    const onContinue = vi.fn()
    render(
      <ResponsibilitiesStep
        value=""
        onChange={() => {}}
        onContinue={onContinue}
        attachments={[attachment]}
        onAttachmentsChange={() => {}}
      />,
    )
    const button = screen.getByRole('button', { name: 'Continue' })
    expect(button).not.toBeDisabled()
    fireEvent.click(button)
    expect(onContinue).toHaveBeenCalledTimes(1)
  })

  it('still enables Continue with text only', () => {
    render(
      <ResponsibilitiesStep
        value="Handle inbound tickets"
        onChange={() => {}}
        onContinue={() => {}}
      />,
    )
    expect(screen.getByRole('button', { name: 'Continue' })).not.toBeDisabled()
  })
})
