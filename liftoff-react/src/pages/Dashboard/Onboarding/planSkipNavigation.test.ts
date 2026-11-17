import { describe, it, expect } from 'vitest'
import { nextStepId, prevStepId } from './types'
import type { OnboardingStepId } from './types'

/**
 * The two navigation rules the plan-skip introduces (ADR-050), asserted against
 * the real step tables rather than a mock.
 *
 * OnboardingPage implements them as `goToStep('invite')` on skip and a
 * special case in `handleBackClick`. These tests pin the properties those two
 * lines have to satisfy, so a future reshuffle of the step arrays that breaks
 * either one fails here rather than stranding a user on a payment form for a
 * plan they declined.
 */

/** Mirrors OnboardingPage.handleBackClick. */
function backFrom(step: OnboardingStepId, plan: string | null): OnboardingStepId {
  if (step === 'invite' && !plan) return 'plan'
  return prevStepId('A', step)
}

describe('skipping the plan step', () => {
  // The whole point of the skip: payment is for people who chose a plan.
  it('jumps over payment to invite', () => {
    // Forward from `plan` normally lands on `payment` …
    expect(nextStepId('A', 'plan')).toBe('payment')
    // … so the skip cannot be goNext(); it has to target `invite` directly,
    // which is the step after payment.
    expect(nextStepId('A', 'payment')).toBe('invite')
  })

  // `invite` is the terminal step, so a plan-skipper lands on the last screen
  // of the wizard and finishes from there. Both of its exits complete
  // onboarding, which is what makes skipping the plan a complete flow rather
  // than one that strands the user a step short.
  it('lands on the terminal step, so skipping still completes', () => {
    expect(nextStepId('A', 'invite')).toBe('invite')
  })
})

describe('back from invite', () => {
  // Without the special case this lands on `payment` — a card form for a plan
  // that was never selected, and a dead end because it cannot be completed.
  it('returns to plan when no plan was chosen', () => {
    expect(prevStepId('A', 'invite')).toBe('payment')
    expect(backFrom('invite', null)).toBe('plan')
  })

  it('returns to payment when a plan WAS chosen', () => {
    expect(backFrom('invite', 'core')).toBe('payment')
  })

  it('does not disturb back from any other step', () => {
    expect(backFrom('payment', 'core')).toBe('plan')
    expect(backFrom('plan', null)).toBe('persona')
    expect(backFrom('persona', null)).toBe('workspace_name')
    expect(backFrom('workspace_name', null)).toBe('welcome')
    expect(backFrom('welcome', null)).toBe('welcome')
  })
})
