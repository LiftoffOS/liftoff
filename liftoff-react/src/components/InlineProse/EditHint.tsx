import './InlineProse.css'

/** What the two keys do while a line is open.
 *
 *  Shown only during an edit, and only for the two things that are not already
 *  muscle memory. Enter making a new line is not worth a line of its own: every
 *  editor anyone has used does that, and saying so made the hint read like
 *  instructions for a tool rather than a note about this one.
 *
 *  One component so the heading and the prose lines cannot drift apart on
 *  wording, which they already did once.
 */
export default function EditHint() {
  return (
    <p className="inline-prose__hint">
      <span><kbd>Esc</kbd> to undo this edit</span>
      <span>Click outside to apply edit</span>
    </p>
  )
}
