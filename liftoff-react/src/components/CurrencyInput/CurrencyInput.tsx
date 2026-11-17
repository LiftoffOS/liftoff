import { useState, useCallback } from 'react'
import './CurrencyInput.css'
import { parseCurrencyValue } from './parseCurrencyValue'

interface CurrencyInputProps {
  value: string
  onChange: (value: string) => void
  placeholder?: string
  disabled?: boolean
  id?: string
  label?: string
  className?: string
}

function formatCurrency(raw: string): string {
  // Strip everything except digits and one decimal point
  const cleaned = raw.replace(/[^0-9.]/g, '')
  const parts = cleaned.split('.')
  if (parts.length > 2) return parts[0] + '.' + parts.slice(1).join('')

  // Add commas to integer part
  let intPart = parts[0] || ''
  // Remove leading zeros (except lone "0")
  intPart = intPart.replace(/^0+(?=\d)/, '')
  // Add thousand separators
  intPart = intPart.replace(/\B(?=(\d{3})+(?!\d))/g, ',')

  if (parts.length === 2) {
    // Limit decimal to 2 places
    return intPart + '.' + parts[1].slice(0, 2)
  }
  return intPart
}


export default function CurrencyInput({
  value,
  onChange,
  placeholder = '0.00',
  disabled = false,
  id,
  label,
  className,
}: CurrencyInputProps) {
  const [focused, setFocused] = useState(false)

  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    const raw = e.target.value
    // Allow empty
    if (!raw) {
      onChange('')
      return
    }
    onChange(formatCurrency(raw))
  }, [onChange])

  const handleBlur = useCallback(() => {
    setFocused(false)
    if (value) {
      const num = parseCurrencyValue(value)
      const formatted = num.toLocaleString('en-US', {
        minimumFractionDigits: 2,
        maximumFractionDigits: 2,
      })
      onChange(formatted)
    }
  }, [value, onChange])

  return (
    <div className={`currency-input ${className || ''}`}>
      {label && <label className="form__label" htmlFor={id}>{label}</label>}
      <div className="currency-input__wrapper">
        <span className="currency-input__prefix">$</span>
        <input
          id={id}
          type="text"
          inputMode="decimal"
          className="form__input currency-input__field"
          value={value}
          onChange={handleChange}
          onFocus={() => setFocused(true)}
          onBlur={handleBlur}
          placeholder={placeholder}
          disabled={disabled}
          data-focused={focused || undefined}
        />
      </div>
    </div>
  )
}
