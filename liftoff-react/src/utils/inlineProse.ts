// Template guidance, broken down far enough to be edited a line at a time.
//
// `markdownSections.ts` already splits a template body into its `## Heading`
// parts. This goes one level further and splits a part's body into the blocks a
// person actually rewrites: a numbered step, a bullet, a bold lead-in, a
// paragraph. The block is the edit unit on the explore detail step, so it is
// also the unit this module reads and writes.
//
// Unlike `markdownSections`, this is NOT display-only. What comes out of
// `markdownFromDraft` is what gets distilled and stored, so the round trip has
// to preserve every `{{connector:...}}` and `{{pick:...}}` the template carries
// — those are resolved against the person's real connections later, and a
// round trip that flattened them would silently swap their Slack channel for a
// generic phrase.

import { splitMarkdownSections } from './markdownSections'

export type ProseBlockKind = 'p' | 'ol' | 'ul' | 'lead'

export interface ProseBlock {
  kind: ProseBlockKind
  /** Source text, tokens intact. Never the resolved display text. */
  text: string
  /** This line carries the person's own words rather than the template's. */
  edited?: boolean
}

export interface ProseSection {
  /** `null` for text that appears before the first heading. */
  heading: string | null
  blocks: ProseBlock[]
}

export type ProseDraft = ProseSection[]

const ORDERED = /^(\d+)[.)]\s+(.*)$/
const BULLET = /^[-*+]\s+(.*)$/
/** A line that is nothing but bold text, optionally ending in a colon. The
 *  catalog uses these to introduce a run of steps ("**Payment runs:**"). */
const LEAD = /^\*\*[^*]+\*\*:?$/

/** Split one section body into its blocks.
 *
 *  A line that starts no new block continues the one above it: the catalog
 *  wraps long numbered steps across several indented source lines, and
 *  treating each of those as its own block would shatter a single step into
 *  fragments that cannot be edited as the sentence they are. A blank line ends
 *  whatever was open.
 */
export function splitProseBlocks(body: string): ProseBlock[] {
  const blocks: ProseBlock[] = []
  let current: ProseBlock | null = null

  for (const raw of (body ?? '').split('\n')) {
    const line = raw.trim()
    if (!line) {
      current = null
      continue
    }

    const ordered = ORDERED.exec(line)
    if (ordered) {
      current = { kind: 'ol', text: ordered[2] }
      blocks.push(current)
      continue
    }

    const bullet = BULLET.exec(line)
    if (bullet) {
      current = { kind: 'ul', text: bullet[1] }
      blocks.push(current)
      continue
    }

    if (LEAD.test(line)) {
      current = { kind: 'lead', text: line }
      blocks.push(current)
      continue
    }

    if (current) {
      current.text += ` ${line}`
      continue
    }

    current = { kind: 'p', text: line }
    blocks.push(current)
  }

  return blocks
}

/** A numbered step's number, derived from where it sits rather than from what
 *  the source said. Inserting or removing a step renumbers the ones below it,
 *  which is the only behaviour that survives editing; a marker parsed out of
 *  the source would leave "1. 2. 2. 4." behind after one insertion. */
export function markerFor(blocks: ProseBlock[], index: number): string {
  const block = blocks[index]
  if (!block) return ''
  if (block.kind === 'ul') return '•'
  if (block.kind !== 'ol') return ''
  let n = 1
  for (let i = index - 1; i >= 0 && blocks[i].kind === 'ol'; i--) n++
  return `${n}.`
}

/** Blocks back to a markdown body.
 *
 *  List items stay on consecutive lines so they remain one list; everything
 *  else is separated by a blank line. This does not reproduce the original
 *  string byte for byte — a numbered step the catalog wrapped over three
 *  indented lines comes back as one line — but it is the same markdown, and
 *  only a template someone has already forked is ever written back.
 */
export function joinProseBlocks(blocks: ProseBlock[]): string {
  const lines: string[] = []
  blocks.forEach((block, i) => {
    const previous = blocks[i - 1]
    const isList = block.kind === 'ol' || block.kind === 'ul'
    const afterList = previous ? previous.kind === 'ol' || previous.kind === 'ul' : false
    if (i > 0 && !(isList && afterList)) lines.push('')
    if (block.kind === 'ol') lines.push(`${markerFor(blocks, i)} ${block.text}`)
    else if (block.kind === 'ul') lines.push(`- ${block.text}`)
    else lines.push(block.text)
  })
  return lines.join('\n')
}

/** A whole template field, ready to edit. */
export function draftFromMarkdown(markdown: string): ProseDraft {
  return splitMarkdownSections(markdown ?? '').map((section) => ({
    heading: section.heading,
    blocks: splitProseBlocks(section.body),
  }))
}

/** A draft back to the string the distiller and the create call are given. */
export function markdownFromDraft(draft: ProseDraft): string {
  return draft
    .map((section) => {
      const body = joinProseBlocks(section.blocks)
      if (section.heading === null) return body
      return body ? `## ${section.heading}\n${body}` : `## ${section.heading}`
    })
    .filter((part) => part.length > 0)
    .join('\n\n')
}

/** Whether any line in the draft carries the person's own words. */
export function draftIsEdited(draft: ProseDraft): boolean {
  return draft.some((section) => section.blocks.some((block) => block.edited))
}

/** How many lines they have rewritten, across every part. */
export function countEditedBlocks(draft: ProseDraft): number {
  return draft.reduce(
    (total, section) => total + section.blocks.filter((block) => block.edited).length,
    0,
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// Inline content
// ─────────────────────────────────────────────────────────────────────────────

/** Bold is a FLAG rather than a kind, because a bold run can contain a
 *  placeholder — "**the watch list you keep in {{pick:working-folder}}**" —
 *  and a `{ kind: 'bold', text }` segment has nowhere to put the token. With
 *  bold as a kind the tokeniser split that run in half, neither half matched
 *  `**...**`, and the asterisks reached the reader as punctuation.
 *
 *  Inline code stays a kind: a placeholder inside backticks is literal by
 *  markdown's own rules, so `code` never has to carry one. */
export type InlineSegment =
  | { kind: 'text'; text: string; bold?: boolean }
  | { kind: 'code'; text: string }
  /** A `{{connector:x}}` or `{{pick:x}}` placeholder, carried verbatim so it
   *  can be written back out after an edit. */
  | { kind: 'token'; token: string; bold?: boolean }

/** A placeholder, in either of the two shapes the catalog writes.
 *
 *  `prefix:name` is a destination or a connector clause. The bare form is a
 *  DECLARED INPUT — `{{company_website}}` — and is only a token when the
 *  template says so: see `isInputToken` on `parseInline`. Matching it here
 *  unconditionally would swallow `{{a_thing}}` somebody typed as literal text,
 *  which is worse than showing it. */
const TOKEN = /\{\{\s*([a-z]+:[a-z][a-z0-9-]*|[a-z][a-z0-9_]*)\s*\}\}/g
/** The two inline marks the catalog uses, as one split grammar.
 *
 *  Exported because the EDITOR renders the same prose and must tokenise it the
 *  same way: `markdownConversion.ts` imports this rather than restating it. A
 *  second copy would be a second answer to what a template means, and the two
 *  surfaces would drift apart one fix at a time. */
export const INLINE_EMPHASIS = /(\*\*[^*]+\*\*|`[^`]+`)/

/** Split a block's text into the pieces a line is rendered from.
 *
 *  Bold and inline code are the only inline markdown the catalog uses inside a
 *  block (checked across all 65 templates: no links, italics, tables or
 *  quotes), so those two plus placeholders are the whole grammar here. Anything
 *  else passes through as literal text rather than being silently dropped.
 *
 *  `isInputToken` decides whether a bare `{{id}}` is one of this template's
 *  declared inputs. Without it only `prefix:name` placeholders are tokens, so
 *  every caller that has no template in hand behaves exactly as before.
 */
export function parseInline(
  text: string,
  isInputToken?: (id: string) => boolean,
): InlineSegment[] {
  const segments: InlineSegment[] = []

  // EMPHASIS FIRST, then placeholders inside each piece. The other order is
  // what broke: a `**...**` run whose middle held a `{{pick:...}}` was cut at
  // the token and neither half still looked bold.
  for (const part of text.split(INLINE_EMPHASIS)) {
    if (!part) continue
    if (part.startsWith('**') && part.endsWith('**') && part.length > 4) {
      pushTokenised(part.slice(2, -2), true)
    } else if (part.startsWith('`') && part.endsWith('`') && part.length > 2) {
      segments.push({ kind: 'code', text: part.slice(1, -1) })
    } else {
      pushTokenised(part, false)
    }
  }
  return segments

  /** Split one run into its placeholders and the words between them, carrying
   *  `bold` onto every piece the run produces. */
  function pushTokenised(chunk: string, bold: boolean) {
    if (!chunk) return
    let last = 0
    let match: RegExpExecArray | null
    TOKEN.lastIndex = 0
    while ((match = TOKEN.exec(chunk)) !== null) {
      const token = match[1]
      // A bare id is a token only when this template declares an input by that
      // name. Undeclared, it is somebody's literal text and stays that way.
      if (!token.includes(':') && !isInputToken?.(token)) continue
      pushWords(chunk.slice(last, match.index), bold)
      segments.push(bold ? { kind: 'token', token, bold } : { kind: 'token', token })
      last = TOKEN.lastIndex
    }
    pushWords(chunk.slice(last), bold)
  }

  function pushWords(chunk: string, bold: boolean) {
    if (!chunk) return
    segments.push(bold ? { kind: 'text', text: chunk, bold } : { kind: 'text', text: chunk })
  }
}

/** Segments back to source text. The inverse of `parseInline`.
 *
 *  A run of bold segments closes with ONE `**`, not one per segment: a bold
 *  run carrying a placeholder arrives here as several segments and has to go
 *  out as the single run it was written as. */
export function inlineToText(segments: InlineSegment[]): string {
  let out = ''
  let inBold = false
  const source = (segment: InlineSegment) =>
    segment.kind === 'token' ? `{{${segment.token}}}`
      : segment.kind === 'code' ? `\`${segment.text}\``
        : segment.text
  for (const segment of segments) {
    const bold = segment.kind !== 'code' && segment.bold === true
    if (bold && !inBold) out += '**'
    if (!bold && inBold) out += '**'
    inBold = bold
    out += source(segment)
  }
  if (inBold) out += '**'
  return out
}
