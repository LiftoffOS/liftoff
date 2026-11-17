import './Checkbox.css'

interface CheckboxProps {
  checked: boolean
  onChange: (checked: boolean) => void
  label?: string
  /** Names the control for assistive tech where the visible label would be
   *  redundant — a row that already says what it is, ticked or not. */
  ariaLabel?: string
  disabled?: boolean
  id?: string
}

export default function Checkbox({ checked, onChange, label, ariaLabel, disabled = false, id }: CheckboxProps) {
  return (
    <label className={`checkbox ${disabled ? 'checkbox--disabled' : ''}`}>
      <input
        type="checkbox"
        id={id}
        checked={checked}
        aria-label={label ? undefined : ariaLabel}
        onChange={e => onChange(e.target.checked)}
        disabled={disabled}
      />
      <span className="checkbox__checkmark" />
      {label && <span className="checkbox__label">{label}</span>}
    </label>
  )
}
