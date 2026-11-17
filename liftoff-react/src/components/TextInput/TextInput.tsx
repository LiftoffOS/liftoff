import { forwardRef, useRef } from 'react'
import SearchIcon from '../../assets/icons/search.svg?react'
import XIcon from '../../assets/icons/x.svg?react'
import './TextInput.css'

type InputVariant = 'default' | 'search'

interface TextInputProps extends React.InputHTMLAttributes<HTMLInputElement> {
  label?: string
  error?: string
  hint?: string
  prefix?: string
  suffix?: string
  variant?: InputVariant
}

const TextInput = forwardRef<HTMLInputElement, TextInputProps>(
  ({ label, error, hint, prefix, suffix, variant = 'default', id, className = '', value, onChange, ...props }, ref) => {
    const hasIcon = variant === 'search'
    const inputRef = useRef<HTMLInputElement>(null)
    const showClear = variant === 'search' && typeof value === 'string' && value.length > 0

    const setRefs = (node: HTMLInputElement | null) => {
      inputRef.current = node
      if (typeof ref === 'function') ref(node)
      else if (ref) (ref as React.MutableRefObject<HTMLInputElement | null>).current = node
    }

    const handleClear = () => {
      if (onChange) {
        const synthetic = {
          target: { value: '' },
          currentTarget: { value: '' },
        } as unknown as React.ChangeEvent<HTMLInputElement>
        onChange(synthetic)
      }
      inputRef.current?.focus()
    }

    return (
      <div className={`text-input ${className}`}>
        {label && (
          <label className="text-input__label" htmlFor={id}>
            {label}
          </label>
        )}
        <div className={`text-input__wrapper ${hasIcon ? 'text-input__wrapper--has-icon' : ''} ${prefix ? 'text-input__wrapper--has-prefix' : ''} ${suffix ? 'text-input__wrapper--has-suffix' : ''} ${showClear ? 'text-input__wrapper--has-clear' : ''}`}>
          {hasIcon && <span className="text-input__icon"><SearchIcon width={16} height={16} /></span>}
          {prefix && <span className="text-input__prefix">{prefix}</span>}
          <input
            ref={setRefs}
            id={id}
            value={value}
            onChange={onChange}
            className={`text-input__field ${error ? 'text-input__field--error' : ''}`}
            {...props}
          />
          {suffix && <span className="text-input__suffix">{suffix}</span>}
          {showClear && (
            <button
              type="button"
              className="text-input__clear"
              onClick={handleClear}
              aria-label="Clear search"
            >
              <XIcon width={14} height={14} />
            </button>
          )}
        </div>
        {hint && !error && (
          <span className="text-input__hint">{hint}</span>
        )}
        {error && (
          <span className="text-input__error">{error}</span>
        )}
      </div>
    )
  }
)

TextInput.displayName = 'TextInput'
export default TextInput
