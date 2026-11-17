import { useState } from 'react'
import { Button } from '../../components'

interface SSNInputProps {
  value: string
  onChange: (value: string) => void
  onSubmit: (ssn: string) => Promise<void>
  label?: string
  hint?: string
  error?: string
}

function formatSSN(raw: string): string {
  const digits = raw.replace(/\D/g, '')
  if (digits.length <= 3) return digits
  if (digits.length <= 5) return `${digits.slice(0, 3)}-${digits.slice(3)}`
  return `${digits.slice(0, 3)}-${digits.slice(3, 5)}-${digits.slice(5, 9)}`
}

/**
 * Secure SSN input that masks on blur and clears after submission.
 * Uses form classes and Button component for consistency.
 */
export function SSNInput({
  value,
  onChange,
  onSubmit,
  label = 'Social Security Number',
  hint,
  error,
}: SSNInputProps) {
  const [isMasked, setIsMasked] = useState(false)
  const [isSubmitting, setIsSubmitting] = useState(false)

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const digits = e.target.value.replace(/\D/g, '').slice(0, 9)
    onChange(digits)
  }

  const handleBlur = () => {
    if (value.length === 9) {
      setIsMasked(true)
    }
  }

  const handleFocus = () => {
    setIsMasked(false)
  }

  const handleSubmit = async () => {
    if (value.length !== 9) return
    setIsSubmitting(true)
    try {
      await onSubmit(value)
      onChange('')
    } finally {
      setIsSubmitting(false)
    }
  }

  const displayValue = isMasked
    ? `***-**-${value.slice(-4)}`
    : formatSSN(value)

  const isComplete = value.length === 9

  return (
    <>
      <div className="form__row">
        <label className="form__label" htmlFor="ssn-field">
          {label}
        </label>
        <input
          id="ssn-field"
          className="form__input"
          style={{ maxWidth: 220 }}
          type="text"
          inputMode="numeric"
          autoComplete="off"
          autoCorrect="off"
          spellCheck={false}
          data-lpignore="true"
          data-1p-ignore="true"
          value={displayValue}
          onChange={handleChange}
          onBlur={handleBlur}
          onFocus={handleFocus}
          placeholder="###-##-####"
          aria-describedby={error ? 'ssn-error' : undefined}
          disabled={isSubmitting}
        />
        {error && (
          <span id="ssn-error" className="form__hint" style={{ color: '#dc2626' }} role="alert">
            {error}
          </span>
        )}
      </div>
      {hint && <p className="form__hint">{hint}</p>}
      <div className="form__actions">
        <Button
          variant="primary"
          size="sm"
          onClick={handleSubmit}
          disabled={!isComplete}
          loading={isSubmitting}
        >
          Continue
        </Button>
      </div>
    </>
  )
}
