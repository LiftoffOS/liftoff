/**
 * What a run is doing, and how it ended when it ended without an answer.
 *
 * A turn can run for minutes. For all of that time the thread holds the
 * person's question and nothing else, which looks exactly like a message that
 * was never delivered and exactly like a run that has already died. The
 * backend APPENDS a line as the work proceeds, throttled to nothing for the
 * first 45 seconds and then at most one line per 20 seconds, so the thread says
 * which of those it is.
 *
 * It used to rewrite a single row, and that is why it no longer does: a
 * rewritten row keeps its original created_at, so the closing "this run took 12
 * minutes" sorted back to where the FIRST update had been and appeared ABOVE
 * the line saying the run was still going. Several rows for one run is the
 * design, not a leak.
 *
 * Not speech, for the same reason the hitl_status rows beside it are not: the
 * team did not say it, and a row that reads as an answer would be worse than
 * no row at all. So it is un-bubbled, quiet, centred, and it never carries an
 * avatar or a name.
 *
 * Rendered from ChatMessages rather than from each page's
 * renderMessageOverride: four surfaces show this transcript today, and a fifth
 * added tomorrow would otherwise render a status line as something a team said.
 *
 * The message types it draws live in `runNarration.ts`, so the grouping helper
 * can read them without importing a component.
 */

interface RunProgressRowProps {
  content: string
}

export function RunProgressRow({ content }: RunProgressRowProps) {
  return (
    // `status` rather than `alert`: this reports, it does not interrupt. A
    // screen reader announces it politely, which is what a line appended every
    // twenty seconds while a run works needs.
    //
    // Its own class rather than the shared status row's. That row is a FLEX
    // line with the dot as a separate item, and these lines grow — "Step 6 of
    // 13. So far: 14 web searches, 18 pages read, 1 document written, 14
    // actions in Liftoff Tool Gateway" — so flex-wrap put the text on its own
    // line and left the dot stranded above it. Here the dot is inline with the
    // text and wraps as part of it.
    <div className="chat-run-progress" role="status">
      <span className="chat-run-progress__dot" aria-hidden="true" />
      {content}
    </div>
  )
}
