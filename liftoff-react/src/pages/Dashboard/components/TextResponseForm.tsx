// Reusable textarea + cancel/confirm pattern. Extracted from the /review queue's
// reject flow so the clarification card variant (no "always apply" checkbox) and
// the reject card (with "always apply" passed via extraControls) share the same
// markup. Per PR0 — see anchor-browser-handoff-backend plan.
//
// Uses the existing `reject-form__*` CSS classes so the reject flow's visual
// styling is preserved exactly; the class names are semantic-neutral enough to
// cover the clarification flow too.
//
// Buttons are `sm`, the size the whole /review panel uses. The default size is
// built for marketing CTAs and reads as oversized in a decision panel.
import { type ReactNode } from 'react'
import { Button } from '../../../components'

interface Props {
  value: string
  onChange: (v: string) => void
  onCancel: () => void
  onConfirm: () => void
  placeholder?: string
  /** Optional textarea label shown above the input. Omit to skip the label. */
  label?: string
  confirmLabel?: string
  confirming?: boolean
  // Optional slot for caller-specific extras, rendered on a line of its own
  // below the action row. Reject flow renders the "Always apply this
  // decision..." checkbox here; clarification flow leaves it undefined.
  //
  // Below the buttons rather than above them because the collapsed panel puts
  // that same checkbox below its own buttons: opening this form used to move
  // the control from under Approve to above Cancel, so the one line on screen
  // that carries a standing decision jumped every time the form opened.
  extraControls?: ReactNode
  /** Optional third button, rendered in the same row as Cancel and Confirm.
   *
   *  The clarification panel needs "Continue Anyway" beside Send. Putting it in
   *  its own block below meant two action areas, and both this form and
   *  `.approval-detail__actions` draw a top border, so the panel showed two
   *  rules where the approval panel shows one. One row, one border. */
  secondaryAction?: ReactNode
}

export function TextResponseForm({
  value,
  onChange,
  onCancel,
  onConfirm,
  placeholder,
  label,
  confirmLabel,
  confirming,
  extraControls,
  secondaryAction,
}: Props) {
  return (
    <>
      <label className="reject-form__label">
        {label}
        <textarea
          className="reject-form__textarea"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          rows={3}
        />
      </label>
      <div className="reject-form__actions">
        <Button
          variant="outline"
          size="sm"
          onClick={onCancel}
          disabled={confirming}
        >
          Cancel
        </Button>
        {secondaryAction}
        <Button
          variant="outline"
          size="sm"
          onClick={onConfirm}
          disabled={confirming}
        >
          {confirming ? 'Working...' : (confirmLabel ?? 'Confirm')}
        </Button>
      </div>
      {extraControls ? (
        <div className="reject-form__extra">{extraControls}</div>
      ) : null}
    </>
  )
}
