/**
 * The quiet status line every chat surface draws for a row about the
 * conversation rather than speech in it: "Waiting on Ada", "Liftoff shared
 * background from the conversation so far".
 *
 * Laid out as one sentence that wraps like text, not as flex items: as items,
 * a narrow column wrapped the dot, the sentence and the chips onto a line each.
 * The dot is a plain inline box, which a line never breaks beside, so it stays
 * with the first word. Chips are atomic and a line may break before them, so
 * the last word is held with them.
 */

import type { ReactNode } from 'react'

interface StatusRowProps {
  text: string
  /** Chips drawn at the end of the sentence, kept on the line of its last word. */
  attribution?: ReactNode
  /** Anything after the sentence that may wrap on its own, such as a link. */
  children?: ReactNode
}

export function StatusRow({ text, attribution, children }: StatusRowProps) {
  const split = attribution ? text.trimEnd().lastIndexOf(' ') : -1
  const head = split >= 0 ? text.slice(0, split + 1) : ''
  const last = split >= 0 ? text.slice(split + 1).trimEnd() : text

  return (
    <div className="chat-page__hitl-status" role="status">
      <span className="chat-page__hitl-status__dot" aria-hidden="true" />
      {attribution ? (
        <>
          {head}
          <span className="chat-page__hitl-status__glue">
            {last}
            {attribution}
          </span>
        </>
      ) : (
        <span>{text}</span>
      )}
      {children}
    </div>
  )
}
