import { useNavigate } from 'react-router'
import { useOnboarding } from '../../../contexts/OnboardingContext'
import { steps } from './onboardingSteps'
import ArrowLeftIcon from '../../../assets/icons/arrow-left.svg?react'
import ArrowRightIcon from '../../../assets/icons/arrow-right.svg?react'
import CheckIcon from '../../../assets/icons/check.svg?react'
import './OnboardingNav.css'

interface OnboardingNavProps {
  onComplete?: () => void
  canProceed?: boolean
}

export default function OnboardingNav({ onComplete, canProceed = true }: OnboardingNavProps) {
  const navigate = useNavigate()
  const { currentStep, setCurrentStep, markStepComplete } = useOnboarding()

  const isFirstStep = currentStep === 1
  const isLastStep = currentStep === steps.length

  const getStepPath = (stepId: number) => {
    const step = steps.find(s => s.id === stepId)
    if (!step) return '/dashboard/onboarding'
    return step.path ? `/dashboard/onboarding/${step.path}` : '/dashboard/onboarding'
  }

  const handlePrevious = () => {
    if (currentStep > 1) {
      const prevStep = currentStep - 1
      setCurrentStep(prevStep)
      navigate(getStepPath(prevStep))
    }
  }

  const handleNext = () => {
    if (currentStep < steps.length) {
      markStepComplete(currentStep)
      const nextStep = currentStep + 1
      setCurrentStep(nextStep)
      navigate(getStepPath(nextStep))
    }
  }

  const handleComplete = () => {
    markStepComplete(currentStep)
    if (onComplete) {
      onComplete()
    } else {
      navigate('/dashboard')
    }
  }

  const handleSaveExit = () => {
    navigate('/dashboard')
  }

  return (
    <div className="onboarding-nav-bar">
      <button
        className="onboarding-nav-bar__btn onboarding-nav-bar__btn--secondary"
        onClick={handleSaveExit}
      >
        Save & Exit
      </button>

      <div className="onboarding-nav-bar__actions">
        <button
          className="onboarding-nav-bar__btn onboarding-nav-bar__btn--secondary"
          onClick={handlePrevious}
          disabled={isFirstStep}
        >
          <ArrowLeftIcon width="16" height="16" />
          Previous
        </button>

        {isLastStep ? (
          <button
            className="onboarding-nav-bar__btn onboarding-nav-bar__btn--primary"
            onClick={handleComplete}
            disabled={!canProceed}
          >
            Complete Setup
            <CheckIcon width="16" height="16" />
          </button>
        ) : (
          <button
            className="onboarding-nav-bar__btn onboarding-nav-bar__btn--primary"
            onClick={handleNext}
            disabled={!canProceed}
          >
            Next
            <ArrowRightIcon width="16" height="16" />
          </button>
        )}
      </div>
    </div>
  )
}
