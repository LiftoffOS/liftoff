import { type ComponentType, type SVGProps } from 'react'
import Button from '../../../components/Button'
import CompassIcon from '../../../assets/icons/compass.svg?react'
import MessageIcon from '../../../assets/icons/message-circle-more.svg?react'
import SlidersIcon from '../../../assets/icons/sliders.svg?react'
import UserPlusIcon from '../../../assets/icons/user-plus.svg?react'
import ChipIcon from '../../../assets/icons/chip.svg?react'
import AsteriskIcon from '../../../assets/icons/asterisk.svg?react'
import type { AccountPersona } from '../../../services/account'

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>

const ROLE_OPTIONS: { id: AccountPersona; label: string; Icon: IconComponent }[] = [
  { id: 'generalist', label: 'Generalist', Icon: CompassIcon },
  { id: 'customer', label: 'Customer-facing', Icon: MessageIcon },
  { id: 'operations', label: 'Internal operations', Icon: SlidersIcon },
  { id: 'talent', label: 'Talent management', Icon: UserPlusIcon },
  { id: 'engineering', label: 'Engineering', Icon: ChipIcon },
  { id: 'other', label: 'Something else', Icon: AsteriskIcon },
]

interface Props {
  value: AccountPersona | null
  onChange: (v: AccountPersona) => void
  onContinue: () => void
  canContinue: boolean
}

/**
 * Verbatim port of the legacy inline RoleStep (OnboardingPage.tsx:438).
 * Renamed to PersonaStep for clarity — the field is account.persona,
 * not internal-agent role. No behavior changes.
 */
export default function PersonaStep({ value, onChange, onContinue, canContinue }: Props) {
  return (
    <div className="onboarding__content">
      <div>
        <h1 className="onboarding__title">Which best describes your work?</h1>
        <p className="onboarding__subtitle">
          We will tailor your workspace for best results.
        </p>
      </div>
      <div className="onboarding-roles">
        {ROLE_OPTIONS.map((opt) => {
          const Icon = opt.Icon
          return (
            <button
              key={opt.id}
              type="button"
              className={`onboarding-role ${value === opt.id ? 'onboarding-role--selected' : ''}`}
              onClick={() => onChange(opt.id)}
            >
              <span
                className={`onboarding-role__icon onboarding-role__icon--${opt.id}`}
                aria-hidden="true"
              >
                <Icon />
              </span>
              <span className="onboarding-role__label">{opt.label}</span>
            </button>
          )
        })}
      </div>
      <div className="onboarding__actions">
        <Button variant="primary" onClick={onContinue} disabled={!canContinue}>
          Continue
        </Button>
      </div>
    </div>
  )
}
