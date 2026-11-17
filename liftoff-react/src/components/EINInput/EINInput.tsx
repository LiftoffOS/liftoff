import './EINInput.css'

interface EINInputProps {
  value: string
  onChange: (value: string) => void
  label?: string
  error?: string
}

function formatEIN(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length <= 2) return digits
  return `${digits.slice(0, 2)}-${digits.slice(2, 9)}`
}

/** EIN input with auto-formatting as ##-#######. */
export function EINInput({
  value,
  onChange,
  label = 'Employer Identification Number',
  error,
}: EINInputProps) {
  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 9)
    onChange(digits)
  }

  const displayValue = formatEIN(value)
  const isComplete = value.length === 9

  return (
    <div className="ein-input">
      <label className="ein-input__label" htmlFor="ein-field">
        {label}
      </label>
      <input
        id="ein-field"
        className={`ein-input__input ${error ? 'ein-input__input--error' : ''}`}
        type="text"
        inputMode="numeric"
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        data-lpignore="true"
        data-1p-ignore="true"
        value={displayValue}
        onChange={handleChange}
        placeholder="##-#######"
        aria-label="Employer Identification Number"
        aria-describedby={error ? 'ein-error' : 'ein-format-hint'}
        aria-invalid={!!error}
      />
      <span id="ein-format-hint" className="ein-input__hint">
        {isComplete ? '9 digits entered' : 'Format: ##-#######'}
      </span>
      {error && (
        <span id="ein-error" className="ein-input__error" role="alert">
          {error}
        </span>
      )}
    </div>
  )
}
