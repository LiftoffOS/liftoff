// Template guidance is authored as one markdown string with `## Heading`
// blocks (see RESPONSIBILITIES_TEMPLATE / GUIDANCE_TEMPLATE). Rendering that
// string whole gives the reader a wall of text; splitting it lets a surface
// show one part at a time.
//
// Display-only. The stored string is never rewritten.

export interface MarkdownSection {
  /** Heading text with the leading `#`s removed. `null` for any text that
   *  appears before the first heading (or for a body with no headings). */
  heading: string | null
  body: string
}

const HEADING = /^\s{0,3}(#{1,6})\s+(.*)$/
const FENCE = /^\s{0,3}(```|~~~)/

/** Split a markdown body into its heading-delimited sections, in source order.
 *
 *  A `#` inside a fenced code block is content, not a heading, so fences are
 *  tracked and their lines pass through untouched. */
export function splitMarkdownSections(markdown: string): MarkdownSection[] {
  const sections: MarkdownSection[] = []
  let current: MarkdownSection | null = null
  let inFence = false

  for (const line of (markdown ?? '').split('\n')) {
    if (FENCE.test(line)) inFence = !inFence

    const match = inFence ? null : HEADING.exec(line)
    if (match) {
      if (current) sections.push(current)
      current = { heading: match[2].trim(), body: '' }
      continue
    }

    if (!current) current = { heading: null, body: '' }
    current.body += current.body ? `\n${line}` : line
  }
  if (current) sections.push(current)

  // A heading with nothing under it still carries meaning; a leading run of
  // blank lines does not.
  return sections
    .map((section) => ({ ...section, body: section.body.trim() }))
    .filter((section) => section.heading !== null || section.body.length > 0)
}
