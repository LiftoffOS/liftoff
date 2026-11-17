// One field of a connection form, rendered the one way.
//
// Extracted from ConnectApiKeyModal, which is where this rendering has always
// lived, so that the custom API capture page renders its declared field with
// the SAME control rather than a second one that drifts. There are two places
// a person types a credential into Liftoff and there must be one way they look
// and behave: the same label, the same error slot, the same disabled state,
// the same `autoComplete="off"` and `spellCheck={false}` on the box a secret
// goes into.
//
// A select renders through Dropdown, which is a button plus a listbox rather
// than a native control — so its label is a <span> in a <div>, not a <label>,
// because there is nothing for a label to bind to and wrapping one would just
// re-toggle the trigger.

import { Dropdown } from './Dropdown'
import TextInput from './TextInput/TextInput'
import type { ApiKeyField } from '../hooks/useApiKeyConnect'

interface ConnectionCredentialFieldProps {
  field: ApiKeyField
  value: string
  onChange: (value: string) => void
  error?: string
  disabled?: boolean
  /** Prefix for the control's DOM id, so two forms on one page cannot collide. */
  idPrefix?: string
}

export default function ConnectionCredentialField({
  field,
  value,
  onChange,
  error,
  disabled = false,
  idPrefix = 'connection-field',
}: ConnectionCredentialFieldProps) {
  const id = `${idPrefix}-${field.name}`

  if (field.type === 'select') {
    return (
      <div className="connection-modal__field">
        <span className="connection-modal__field-label">{field.label}</span>
        <Dropdown
          options={field.options ?? []}
          value={value}
          onChange={onChange}
          placeholder={field.placeholder}
          disabled={disabled}
        />
        {error && <span className="connection-modal__field-error">{error}</span>}
      </div>
    )
  }

  if (field.type === 'textarea') {
    // Multi-line input for a pasted PEM certificate or key block (e.g. ADP).
    return (
      <div className="connection-modal__field">
        <label className="connection-modal__field-label" htmlFor={id}>
          {field.label}
        </label>
        <textarea
          id={id}
          className="connection-modal__field-textarea"
          rows={6}
          placeholder={field.placeholder}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          autoComplete="off"
          spellCheck={false}
        />
        {error && <span className="connection-modal__field-error">{error}</span>}
      </div>
    )
  }

  return (
    <TextInput
      id={id}
      label={field.label}
      type={field.type}
      placeholder={field.placeholder}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      error={error}
      disabled={disabled}
      autoComplete="off"
    />
  )
}
