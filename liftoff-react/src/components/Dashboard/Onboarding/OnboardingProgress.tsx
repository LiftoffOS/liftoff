import { NavLink } from 'react-router'
import { useOnboarding } from '../../../contexts/OnboardingContext'
import CheckIcon from '../../../assets/icons/check.svg?react'
import { steps } from './onboardingSteps'
import './OnboardingProgress.css'

export default function OnboardingProgress() {
  const { currentStep, isStepComplete, canNavigateToStep } = useOnboarding()

  return (
    <div className="onboarding-progress-bar">
      {steps.map((step, index) => {
        const isActive = step.id === currentStep
        const isComplete = isStepComplete(step.id)
        const canNavigate = canNavigateToStep(step.id)
        const basePath = '/dashboard/onboarding'
        const fullPath = step.path ? `${basePath}/${step.path}` : basePath

        return (
          <div key={step.id} className="onboarding-progress-bar__item">
            {canNavigate ? (
              <NavLink
                to={fullPath}
                className={`progress-step-link ${isActive ? 'progress-step-link--active' : ''} ${isComplete ? 'progress-step-link--completed' : ''}`}
              >
                <div className="progress-step-link__number">
                  {isComplete ? (
                    <CheckIcon width="14" height="14" />
                  ) : (
                    step.id
                  )}
                </div>
                <div className="progress-step-link__content">
                  <span className="progress-step-link__title">{step.title}</span>
                  <span className="progress-step-link__description">{step.description}</span>
                </div>
              </NavLink>
            ) : (
              <div className="progress-step-link progress-step-link--disabled">
                <div className="progress-step-link__number">{step.id}</div>
                <div className="progress-step-link__content">
                  <span className="progress-step-link__title">{step.title}</span>
                  <span className="progress-step-link__description">{step.description}</span>
                </div>
              </div>
            )}
            {index < steps.length - 1 && <div className="progress-step-link__connector" />}
          </div>
        )
      })}
    </div>
  )
}

