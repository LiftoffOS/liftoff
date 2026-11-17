import { useCallback } from 'react'
import './DateInput.css'

interface DateInputProps {
  value: string
  onChange: (value: string) => void
  label?: string
  placeholder?: string
  disabled?: boolean
  id?: string
}

function formatDateValue(raw: string): string {
  // Strip everything except digits
  const digits = raw.replace(/\D/g, '').slice(0, 8)

  if (digits.length <= 2) return digits
  if (digits.length <= 4) return `${digits.slice(0, 2)}/${digits.slice(2)}`
  return `${digits.slice(0, 2)}/${digits.slice(2, 4)}/${digits.slice(4)}`
}

export default function DateInput({
  value,
  onChange,
  label,
  placeholder = 'MM/DD/YYYY',
  disabled = false,
  id,
}: DateInputProps) {
  const handleChange = useCallback((e: React.ChangeEvent<HTMLInputElement>) => {
    onChange(formatDateValue(e.target.value))
  }, [onChange])

  return (
    <div className="date-input">
      {label && (
        <label className="date-input__label" htmlFor={id}>{label}</label>
      )}
      <input
        id={id}
        type="text"
        className="date-input__field"
        value={value}
        onChange={handleChange}
        placeholder={placeholder}
        disabled={disabled}
        inputMode="numeric"
        maxLength={10}
      />
    </div>
  )
}
