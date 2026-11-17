import Button from '../../../components/Button'
import type { OnboardingPath } from './types'

interface Props {
  path: OnboardingPath
  onBegin: () => void
}

/**
 * Welcome cover (step 0). Subtitle copy varies by path — path B users
 * arrived with a role in mind (`?role=`), so the framing is
 * "Let's get your agent set up" rather than "workspace setup."
 */
export default function WelcomeStep({ path, onBegin }: Props) {
  const subtitle = path === 'B'
    ? "Let's get your agent set up"
    : "Let's begin your workspace setup"
  return (
    <div className="onboarding-welcome">
      <h1 className="onboarding-welcome__title">Welcome to Liftoff</h1>
      <p className="onboarding-welcome__subtitle">{subtitle}</p>
      <div className="onboarding-welcome__cta">
        <Button variant="primary" onClick={onBegin}>
          Begin
        </Button>
      </div>
    </div>
  )
}
