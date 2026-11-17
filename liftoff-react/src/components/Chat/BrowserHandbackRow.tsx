/**
 * The status line a thread keeps when the person handed the browser back, or
 * pointed at something in it: "Ada handed the browser back", "Ada pointed at
 * link "Sports"".
 *
 * The person's own act, written by the backend as a row about the
 * conversation rather than something said in it, and read by no model: what
 * they did in the browser reaches the assistant through the Browser section
 * of its next turn, never through this row. Drawn as the same quiet status
 * row a forwarded note gets, because it is the same kind of thing: a report
 * on the conversation, not speech. Unattributed, on purpose: the sentence
 * names the person, and a chip means a colleague had a hand in a row.
 */

import { StatusRow } from './StatusRow'

interface BrowserHandbackRowProps {
  content: string
}

export function BrowserHandbackRow({ content }: BrowserHandbackRowProps) {
  return <StatusRow text={content} />
}
