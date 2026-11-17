import Button from '../../../../components/Button'
import RoleInput from '../../../../components/RoleInput'
import { useToast } from '../../../../contexts/ToastContext'
import { TOAST_MESSAGES } from '../../../../constants/toastMessages'
import { TEAM_LIMITS } from '../../../../constants/limits'

interface RoleStepProps {
  value: string
  onChange: (value: string) => void
  onContinue: () => void
}

export default function RoleStep({ value, onChange, onContinue }: RoleStepProps) {
  const { showToast } = useToast()

  const handleContinue = () => {
    if (value.length > TEAM_LIMITS.ROLE_MAX) {
      showToast(TOAST_MESSAGES.VALIDATION_TOO_LONG, 'error')
      return
    }
    if (value.trim()) {
      onContinue()
    }
  }

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    handleContinue()
  }

  return (
    <form className="agent-builder-step" onSubmit={handleSubmit}>
      <RoleInput
        value={value}
        onChange={onChange}
        titleAs="h1"
        titleClassName="agent-builder-step__header"
      />

      <div className="agent-builder-nav">
        <Button variant="primary" onClick={handleContinue} disabled={!value.trim()}>
          Continue
        </Button>
      </div>
    </form>
  )
}
