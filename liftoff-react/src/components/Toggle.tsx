import './Toggle.css'

interface ToggleProps {
  checked: boolean
  onChange: () => void
  disabled?: boolean
  size?: 'sm' | 'md'
  /** What this switch controls. Required, and read out rather than shown: a
   *  switch is always placed beside its own copy, so a caller that cannot say
   *  what it toggles is a caller whose users cannot tell either. */
  label: string
}

export default function Toggle({ checked, onChange, disabled = false, size = 'md', label }: ToggleProps) {
  return (
    <label className={`toggle toggle--${size} ${disabled ? 'toggle--disabled' : ''}`}>
      <span className="sr-only">{label}</span>
      <input
        type="checkbox"
        checked={checked}
        onChange={onChange}
        disabled={disabled}
      />
      <span className="toggle__slider" />
    </label>
  )
}
