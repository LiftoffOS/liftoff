/**
 * The status line a colleague's thread keeps when another assistant brought it
 * in: "Insights Manager shared background from the conversation so far".
 *
 * A colleague answers in its own thread and cannot see the conversation it was
 * brought into, so the one asking (Liftoff, the Insights Manager, the Chief AI
 * Officer or an agent) writes a brief for it. That brief is one model's note
 * to another: third person about the person, terse, carrying the identifiers
 * and directives a colleague needs. It used to be persisted as a row this
 * component rendered behind a disclosure, where it could show a team's id
 * and "confirm you are targeting that id". Every agent platform keeps such a
 * brief out of the end-user surface, and so does this one now: the backend
 * reads it for one turn and stores only this one line, attributed to whoever
 * forwarded it.
 *
 * Rows written before that change still carry the old brief after a blank
 * line. Nothing of it is rendered: this component shows the status line the
 * row starts with, and when a row does not start with one, the label every
 * such row used to open with. There is no expandable body, on purpose.
 *
 * Drawn as the same quiet status row a paused hand-over gets, because it is
 * the same kind of thing: a report on the conversation, not speech. It IS
 * attributed, through the same chip a reply's contributors are drawn with:
 * under the rule every surface follows, a chip means a colleague other than
 * this page's own assistant had a hand in the row.
 */

import type { Contributor } from '../../types/contributors'
import { ContributorChips } from './ChatMessages'
import { StatusRow } from './StatusRow'

/** Marks a row as forwarded background rather than speech. Must match the
 *  backend constant of the same name, which is what writes it. */
export const FORWARDED_CONTEXT_MESSAGE_TYPE = 'forwarded_context'

/** Who forwarded a row that carries no contributors: Liftoff, which was the
 *  only assistant that could forward one before the field was stamped. */
const LIFTOFF_CONTRIBUTORS: Contributor[] = [{ id: 'liftoff', label: 'Liftoff' }]

/** What every status line ends with, on every surface: the backends spell it
 *  this way (`forwardedContextStatus`), and only a line that ends this way is
 *  rendered, so nothing else a row might hold can reach the screen. */
const STATUS_SUFFIX = ' shared background from the conversation so far'

/** Shown for a row whose first line is not a status line, which no backend
 *  writes: the label every older row opened with, so the row still reads as
 *  what it is rather than showing whatever it holds. */
const FALLBACK_LABEL = `Liftoff${STATUS_SUFFIX}`

interface ForwardedContextRowProps {
  content: string
  /** The row's own `contributors`: whoever forwarded the background. Absent
   *  or empty on a row written before the field was stamped, which was
   *  always Liftoff's. */
  contributors?: Contributor[]
}

/** The status line of a stored row, and only that. */
function forwardedContextLabel(content: string): string {
  const firstLine = content.split('\n', 1)[0]?.trim() ?? ''
  return firstLine.endsWith(STATUS_SUFFIX) ? firstLine : FALLBACK_LABEL
}

export function ForwardedContextRow({ content, contributors }: ForwardedContextRowProps) {
  const forwardedBy = contributors && contributors.length > 0 ? contributors : LIFTOFF_CONTRIBUTORS

  return (
    <StatusRow
      text={forwardedContextLabel(content)}
      // Who forwarded it, drawn the way every reply's contributors are, right
      // after the sentence: the far edge is the person's side.
      attribution={<ContributorChips contributors={forwardedBy} />}
    />
  )
}
