/**
 * One run's narration, folded to a line.
 *
 * The rows themselves are unchanged and still appended one per update: that is
 * deliberate backend behaviour, because a single row rewritten in place showed
 * only the latest state and the earlier updates vanished. This is purely how
 * they are shown.
 *
 * Folded, a one-minute run stops leaving three status lines in the transcript
 * and an eleven-minute one stops leaving fourteen — and the conversation ends on
 * the agent's answer rather than on "This run took 1 minute", which it does
 * because the closing summary is written by a wrapper that only learns the run
 * ended after the reply has already been saved.
 *
 * It folds ONLY when the run was answered. A run still working stays open, or
 * the person is back to watching a blank thread; a run that ended without an
 * answer stays open too, because a dead turn that looked identical to a live one
 * is the entire reason these rows exist.
 */
import { useState } from 'react'
import './ChatMessages.css'

interface RunProgressGroupProps {
  /** Every line this run wrote, in order. */
  lines: { id: string; content: string }[]
  /** What the folded line says: the run's own last row, not a re-derived summary. */
  label: string
  /** False while the run is live and when it ended without a reply. */
  answered: boolean
}

export function RunProgressGroup({ lines, label, answered }: RunProgressGroupProps) {
  const [open, setOpen] = useState(!answered)

  // A single line has nothing to fold. Showing a disclosure control there would
  // add a click to reach text already fully visible.
  if (lines.length <= 1) {
    return (
      <div className="chat-run-progress" role="status">
        <span className="chat-run-progress__dot" aria-hidden="true" />
        {label}
      </div>
    )
  }

  return (
    // `status` rather than `alert`, as the single row uses: this reports, it
    // does not interrupt.
    <div className="chat-run-progress-group" role="status">
      <button
        type="button"
        className="chat-run-progress-group__summary"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
      >
        <span className="chat-run-progress-group__chevron" aria-hidden="true">
          {open ? '⌄' : '›'}
        </span>
        <span className="chat-run-progress-group__label">{label}</span>
        {/* The count is what tells a reader there is more behind the line. */}
        <span className="chat-run-progress-group__count">{lines.length} updates</span>
      </button>

      {open && (
        <div className="chat-run-progress-group__lines">
          {lines.map((line) => (
            <div key={line.id} className="chat-run-progress-group__line">
              {line.content}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
