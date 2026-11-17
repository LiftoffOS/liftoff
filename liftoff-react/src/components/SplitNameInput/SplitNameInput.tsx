import { useRef } from 'react'
import './SplitNameInput.css'

interface SplitNameInputProps {
  label?: string
  firstNameValue: string
  lastNameValue: string
  firstNameField?: string
  lastNameField?: string
  onChange: (e: React.ChangeEvent<HTMLInputElement>) => void
  maxLength?: number
  error?: boolean
}

/**
 * Single-pill name input that captures first and last name as two separate
 * inputs internally. Visually one component, mechanically two state fields —
 * so downstream consumers (CRM, etc.) get clean firstName/lastName values
 * without parsing a free-text "name" string.
 */
export default function SplitNameInput({
  label,
  firstNameValue,
  lastNameValue,
  firstNameField = 'firstName',
  lastNameField = 'lastName',
  onChange,
  maxLength = 250,
  error = false,
}: SplitNameInputProps) {
  const labelId = `${firstNameField}-${lastNameField}-label`
  const firstNameRef = useRef<HTMLInputElement>(null)
  const lastNameRef = useRef<HTMLInputElement>(null)

  const focusLastName = (cursorPos: number) => {
    requestAnimationFrame(() => {
      const el = lastNameRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(cursorPos, cursorPos)
      }
    })
  }

  const focusFirstName = (cursorPos: number) => {
    requestAnimationFrame(() => {
      const el = firstNameRef.current
      if (el) {
        el.focus()
        el.setSelectionRange(cursorPos, cursorPos)
      }
    })
  }

  // First-name keydown:
  //   - Space (after at least one non-space char) jumps to last-name.
  //   - Right arrow at the end of the field jumps to start of last-name.
  const handleFirstNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === ' ' && firstNameValue.trim().length > 0) {
      e.preventDefault()
      lastNameRef.current?.focus()
      return
    }
    if (e.key === 'ArrowRight') {
      const input = e.currentTarget
      if (input.selectionStart === firstNameValue.length && input.selectionEnd === firstNameValue.length) {
        e.preventDefault()
        focusLastName(0)
      }
    }
  }

  // Last-name keydown:
  //   - Backspace at empty deletes the trailing first-name char and shifts
  //     focus there, so holding backspace continues deleting naturally.
  //   - Left arrow at start jumps to the end of first-name.
  const handleLastNameKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Backspace' && lastNameValue === '' && firstNameValue.length > 0) {
      e.preventDefault()
      const next = firstNameValue.slice(0, -1)
      onChange({
        target: { name: firstNameField, value: next },
      } as React.ChangeEvent<HTMLInputElement>)
      focusFirstName(next.length)
      return
    }
    if (e.key === 'ArrowLeft') {
      const input = e.currentTarget
      if (input.selectionStart === 0 && input.selectionEnd === 0) {
        e.preventDefault()
        focusFirstName(firstNameValue.length)
      }
    }
  }

  // Pasting a multi-word string into first-name splits on the first space:
  // first chunk → firstName, remainder → lastName. Both fields are replaced
  // entirely, then focus moves to the end of last-name.
  const handleFirstNamePaste = (e: React.ClipboardEvent<HTMLInputElement>) => {
    const text = e.clipboardData.getData('text').trim()
    const spaceIdx = text.search(/\s/)
    if (spaceIdx === -1) return
    e.preventDefault()
    const first = text.slice(0, spaceIdx)
    const last = text.slice(spaceIdx + 1).trim()
    onChange({ target: { name: firstNameField, value: first } } as React.ChangeEvent<HTMLInputElement>)
    onChange({ target: { name: lastNameField, value: last } } as React.ChangeEvent<HTMLInputElement>)
    focusLastName(last.length)
  }

  return (
    <div className="split-name-input">
      {label && (
        <label className="split-name-input__label" id={labelId}>
          {label}
        </label>
      )}
      <div
        className={`split-name-input__wrapper${error ? ' split-name-input__wrapper--error' : ''}`}
        role="group"
        aria-labelledby={label ? labelId : undefined}
      >
        <input
          ref={firstNameRef}
          type="text"
          name={firstNameField}
          value={firstNameValue}
          onChange={onChange}
          onKeyDown={handleFirstNameKeyDown}
          onPaste={handleFirstNamePaste}
          placeholder="First name"
          aria-label="First name"
          className="split-name-input__input"
          maxLength={maxLength}
          autoComplete="given-name"
          size={1}
        />
        <input
          ref={lastNameRef}
          type="text"
          name={lastNameField}
          value={lastNameValue}
          onChange={onChange}
          onKeyDown={handleLastNameKeyDown}
          placeholder="Last name"
          aria-label="Last name"
          className="split-name-input__input"
          maxLength={maxLength}
          autoComplete="family-name"
          size={1}
        />
      </div>
    </div>
  )
}
