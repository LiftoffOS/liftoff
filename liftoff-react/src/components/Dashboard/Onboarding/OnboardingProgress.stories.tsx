import type { Meta, StoryObj } from '@storybook/react'
import { useEffect } from 'react'
import { MemoryRouter } from 'react-router'
// OnboardingProvider provides required context
import {  useOnboarding } from '../../../contexts/OnboardingContext'
import { OnboardingProvider } from '../../../contexts/OnboardingProvider'
import OnboardingProgress from './OnboardingProgress'

const meta: Meta<typeof OnboardingProgress> = {
  title: 'Components/Dashboard/Onboarding/OnboardingProgress',
  component: OnboardingProgress,
  parameters: { layout: 'centered' },
}

export default meta
type Story = StoryObj<typeof OnboardingProgress>

// Helper wrapper to render progress from a specific step with prior steps completed
function ProgressAtStep({ step, completedUpTo }: { step: number; completedUpTo: number }) {
  return (
    <MemoryRouter initialEntries={['/dashboard/onboarding']}>
      <OnboardingProvider>
        <ProgressStepper currentStep={step} completedUpTo={completedUpTo} />
      </OnboardingProvider>
    </MemoryRouter>
  )
}

/**
 * Moves the provider to the step this story wants to show.
 *
 * The provider owns the step state, so its own setters are the only way in.
 * They run from an effect rather than during render: writing to a parent's
 * state while a child renders is not allowed, and React rejects it. The reset
 * first matters because the provider persists to localStorage, so without it a
 * story would inherit whichever steps the previously opened story completed.
 */
function ProgressStepper({ currentStep, completedUpTo }: { currentStep: number; completedUpTo: number }) {
  const { resetOnboarding, setCurrentStep, markStepComplete } = useOnboarding()

  // Seeds once per step change. The setters are new on every render, so
  // depending on them would re-seed forever.
  useEffect(() => {
    resetOnboarding()
    for (let step = 1; step <= completedUpTo; step++) {
      markStepComplete(step)
    }
    setCurrentStep(currentStep)
  }, [currentStep, completedUpTo]) // eslint-disable-line react-hooks/exhaustive-deps

  return <OnboardingProgress />
}

// Step 1 active, fresh start, nothing completed. Seeded like the rest rather
// than left to the provider's default, because the default is whatever the last
// story you opened persisted to localStorage.
export const StepOne: Story = {
  render: () => <ProgressAtStep step={1} completedUpTo={0} />,
}

export const MidProgress: Story = {
  render: () => <ProgressAtStep step={4} completedUpTo={3} />,
}

export const NearlyComplete: Story = {
  render: () => <ProgressAtStep step={7} completedUpTo={6} />,
}

export const AllComplete: Story = {
  render: () => <ProgressAtStep step={8} completedUpTo={8} />,
}
