// The last screen of the build must not fail silently.
//
// Both buttons here call a create that can be rejected, and neither handler
// passed an error handler at all: the mutation failed, the spinner stopped,
// `pendingAction` reset, and the screen was byte-for-byte unchanged. A customer
// sat on this screen pressing a button that had already told the server no.

import { describe, it, expect, vi } from 'vitest'
import { render, screen } from '@testing-library/react'
import CompletionStep from './CompletionStep'

function renderStep(props: Partial<React.ComponentProps<typeof CompletionStep>> = {}) {
  return render(
    <CompletionStep
      // CompletionStep's `role` is the team's job title, not an ARIA role.
      // eslint-disable-next-line jsx-a11y/aria-role
      role="campaign analyst"
      scopeSummary="Finds new campaigns daily."
      integrations={[]}
      onLaunch={vi.fn()}
      onNotNow={vi.fn()}
      {...props}
    />,
  )
}

describe('CompletionStep', () => {
  it('shows nothing extra when there is no error', () => {
    renderStep()

    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /launch now/i })).toBeInTheDocument()
  })

  it('surfaces a failed create as an announced message', () => {
    // role="alert" rather than a bare paragraph: this appears in response to an
    // action on an otherwise static screen, so a screen reader has to be told.
    renderStep({ error: 'Could not create the agent. Please try again.' })

    const alert = screen.getByRole('alert')
    expect(alert).toHaveTextContent('Could not create the agent. Please try again.')
  })

  it('keeps both buttons usable after a failure so the person can retry', () => {
    // The failure is not terminal — the distillation is already paid for and still
    // in state, so retrying costs nothing and is the obvious next move.
    renderStep({ error: 'Could not save the agent. Please try again.' })

    expect(screen.getByRole('button', { name: /launch now/i })).toBeEnabled()
    expect(screen.getByRole('button', { name: /maybe later/i })).toBeEnabled()
  })

  it('does not render raw validation detail as user-facing copy', () => {
    // The field path goes to telemetry, never to the screen: "workflowSteps[1]"
    // means nothing to the person who wrote a paragraph of prose.
    renderStep({ error: 'Could not create the agent. Please try again.' })

    expect(screen.queryByText(/workflowSteps/)).not.toBeInTheDocument()
    expect(screen.queryByText(/too_big/)).not.toBeInTheDocument()
  })
})

// ── Waved strategy: the screen renders before the artifact is finished ──────
//
// Under the split the summary arrives seconds in and this screen appears while
// the rest of the distillation is still running. That creates three states the
// screen never had to handle before: a decision taken while work is in flight,
// a failure that lands after the screen is already up, and progress that has to
// be legible on a button rather than a full-screen loader.

describe('CompletionStep while the distillation is still running', () => {
  it('shows the stage line, not a bare spinner, once a decision is pending', () => {
    // A spinning button reads as stuck. Named progress reads as working, and
    // the wait here can run to the better part of a minute.
    renderStep({ finalizing: true, isLaunching: true, finalizingStage: 'generating' })

    expect(screen.getByRole('status')).toBeInTheDocument()
    expect(screen.getByRole('status').textContent).toBeTruthy()
  })

  it('says nothing while waiting if no decision has been taken', () => {
    // Before a click the screen is readable and complete. Progress chatter
    // there would be noise about work the person has not asked to wait for.
    renderStep({ finalizing: true })

    expect(screen.queryByRole('status')).not.toBeInTheDocument()
  })

  it('offers a retry when the artifact never arrived', () => {
    // The "Try Again" button lives on the loading step, which is no longer on
    // screen once the summary has promoted us here. Without this the person is
    // looking at an error beside two buttons that cannot proceed.
    const onRetryDistill = vi.fn()
    renderStep({ error: 'Distillation failed.', onRetryDistill })

    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /launch now/i })).toBeDisabled()
    expect(screen.getByRole('button', { name: /maybe later/i })).toBeDisabled()
  })

  it('does not offer a retry when the artifact is fine and only the create failed', () => {
    // A rejected create is a different failure: the artifact is good and the
    // two buttons can be pressed again, so re-distilling would throw away work
    // to retry the wrong step.
    renderStep({ error: 'Could not create the agent.' })

    expect(screen.queryByRole('button', { name: /try again/i })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /launch now/i })).toBeEnabled()
  })
})
