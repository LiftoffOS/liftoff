import Button from '../../../components/Button'
import { useAutoFocus } from '../../../hooks/useAutoFocus'

const WORKSPACE_NAME_MAX = 30

interface Props {
  value: string
  onChange: (v: string) => void
  onContinue: () => void
  canContinue: boolean
}

/**
 * Verbatim port of the legacy inline WorkspaceNameStep (OnboardingPage.tsx:390).
 * No behavior changes.
 */
export default function WorkspaceNameStep({ value, onChange, onContinue, canContinue }: Props) {
  const nameRef = useAutoFocus<HTMLInputElement>()
  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    if (canContinue) onContinue()
  }

  return (
    <form className="onboarding__content onboarding__content--centered" onSubmit={handleSubmit}>
      <div>
        <h1 className="onboarding__title">What&rsquo;s the name of your company or team?</h1>
        <p className="onboarding__subtitle">
          This will be the name of your Liftoff workspace.
        </p>
      </div>
      <div className="onboarding-name-input">
        <input
          type="text"
          className="onboarding-name-input__field"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="Acme, Inc."
          maxLength={WORKSPACE_NAME_MAX}
          ref={nameRef}
        />
        <span className="onboarding-name-input__count" aria-hidden="true">
          {value.length}/{WORKSPACE_NAME_MAX}
        </span>
      </div>
      <div className="onboarding__actions">
        <Button variant="primary" onClick={onContinue} disabled={!canContinue}>
          Continue
        </Button>
      </div>
    </form>
  )
}
