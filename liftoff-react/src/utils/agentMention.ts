/** Agent mention parsing, roster building, and UI item conversion for the
 *  @mention chat router.
 *
 *  A mention is stored in the composer as an explicitly delimited token,
 *  `<OPEN>@Label<CLOSE>`, rather than as bare "@Label" text. The delimiters are
 *  invisible Unicode format characters, so the person still sees exactly
 *  "@Label" and the textarea lays out identically, but every consumer can find
 *  a mention by an exact delimiter scan instead of guessing at where a label
 *  starts and ends.
 *
 *  That distinction is the whole point. Matching bare text cannot tell a real
 *  mention from a half-deleted one: "@Release Program Manager" mid-backspace
 *  still looks like the start of a mention, so the popover keeps re-triggering
 *  and the caret gets trapped. A token with a broken delimiter pair is simply
 *  not a token, so the ambiguity disappears rather than being worked around. */

/** INVISIBLE TIMES. Opens a mention token. */
export const MENTION_OPEN = '⁢'
/** INVISIBLE SEPARATOR. Closes a mention token. */
export const MENTION_CLOSE = '⁣'

/** Both delimiters, for bulk removal. */
const MENTION_MARKERS = /[⁢⁣]/g

export type MentionRosterItem =
  | { kind: 'liftoff'; id: 'liftoff'; label: 'Liftoff' }
  | { kind: 'caio'; id: 'caio'; label: 'Chief AI Officer' }
  | { kind: 'insights'; id: 'insights'; label: 'Insights Manager' }
  | { kind: 'team'; id: string; label: string }

export const SPECIAL_MENTION_ITEMS: readonly MentionRosterItem[] = [
  { kind: 'liftoff', id: 'liftoff', label: 'Liftoff' },
  { kind: 'caio', id: 'caio', label: 'Chief AI Officer' },
  { kind: 'insights', id: 'insights', label: 'Insights Manager' },
]

export interface AgentMentionItem {
  id: string
  label: string
}

/** Build the full mention roster: system agents + active custom teams. */
export function buildMentionRoster(teams: Array<{ id: string; role: string }>): MentionRosterItem[] {
  const roster: MentionRosterItem[] = [...SPECIAL_MENTION_ITEMS]
  for (const team of teams) {
    roster.push({ kind: 'team', id: team.id, label: team.role })
  }
  return roster
}

/** Convert mention roster to the shape AgentMentionList.tsx expects. */
export function toMentionListItems(roster: MentionRosterItem[]): AgentMentionItem[] {
  return roster.map(item => ({ id: item.id, label: item.label }))
}

/** The composer text for a chosen roster entry. */
export function makeMentionToken(label: string): string {
  return `${MENTION_OPEN}@${label}${MENTION_CLOSE}`
}

export interface MentionToken {
  label: string
  /** Index of the opening delimiter. */
  start: number
  /** Index one past the closing delimiter, so `text.slice(start, end)` is the
   *  whole token. */
  end: number
}

/** Every well-formed token in `text`, left to right. A token is an opening
 *  delimiter, '@', a label containing no delimiters, then a closing delimiter.
 *  Orphaned or malformed delimiters are skipped rather than throwing, so
 *  partially edited text degrades to "no mention" instead of erroring. */
export function findMentionTokens(text: string): MentionToken[] {
  const tokens: MentionToken[] = []
  let cursor = 0

  while (cursor < text.length) {
    const start = text.indexOf(MENTION_OPEN, cursor)
    if (start === -1) break

    const close = text.indexOf(MENTION_CLOSE, start + 1)
    if (close === -1) break

    const inner = text.slice(start + 1, close)

    // A second opener inside the span means the first one was orphaned by an
    // edit. Resume from just after it so the later, intact pair is still found.
    if (inner.includes(MENTION_OPEN)) {
      cursor = start + 1
      continue
    }

    if (inner.startsWith('@')) {
      tokens.push({ label: inner.slice(1), start, end: close + 1 })
    }
    cursor = close + 1
  }

  return tokens
}

/** Strip every delimiter, leaving the text as the person sees it. Applied
 *  before anything leaves the composer so a marker can never reach the
 *  backend, including any orphan that survived editing. */
export function stripMentionMarkers(text: string): string {
  return text.replace(MENTION_MARKERS, '')
}

/** The token a Backspace at `caret` should remove: the one the caret sits
 *  immediately after, or inside. */
export function mentionTokenBeforeCaret(text: string, caret: number): MentionToken | null {
  return findMentionTokens(text).find(token => caret > token.start && caret <= token.end) ?? null
}

/** The token a Delete at `caret` should remove: the one the caret sits
 *  immediately before, or inside. */
export function mentionTokenAfterCaret(text: string, caret: number): MentionToken | null {
  return findMentionTokens(text).find(token => caret >= token.start && caret < token.end) ?? null
}

export interface OpenMentionSpan {
  atIndex: number
  caretIndex: number
  query: string
}

/** Scan backward from the caret for an unterminated "@query" the person is
 *  still typing, which is what drives the picker.
 *
 *  Returns null for a completed token (its '@' is already bracketed by
 *  delimiters and belongs to that token), for an email-like "foo@bar" where the
 *  '@' is not at a word boundary, and when there is no '@' to anchor on. */
export function findOpenMentionSpan(text: string, caretIndex: number): OpenMentionSpan | null {
  if (caretIndex < 0 || caretIndex > text.length) return null

  let i = caretIndex - 1
  const query: string[] = []

  while (i >= 0 && text[i] !== ' ' && text[i] !== '\n' && text[i] !== '\t') {
    // Running into either delimiter means the caret is on or behind a
    // completed token, so there is no open mention to complete.
    if (text[i] === MENTION_OPEN || text[i] === MENTION_CLOSE) return null
    if (text[i] !== '@') query.unshift(text[i])
    i--
  }

  const atIndex = i + 1
  if (atIndex >= text.length || text[atIndex] !== '@') return null

  const beforeAt = atIndex > 0 ? text[atIndex - 1] : null
  if (beforeAt !== null && beforeAt !== ' ' && beforeAt !== '\n' && beforeAt !== '\t') {
    return null
  }

  return { atIndex, caretIndex, query: query.join('') }
}

/** Collapse the double space that stripping a mid-sentence token leaves
 *  behind, and drop the edges. */
function normalizeSpacing(text: string): string {
  return text.replace(/ {2,}/g, ' ').trim()
}

/** Resolve the routing target from composer text and remove its token, so the
 *  agent receives the message without the literal "@Name".
 *
 *  The first token whose label is in the roster wins. Labels are compared
 *  exactly, because the delimiters already establish where the label ends;
 *  there is no prefix ambiguity to break ties on. */
export function parseAgentMention(
  text: string,
  roster: MentionRosterItem[],
): { strippedText: string; target: MentionRosterItem | null } {
  for (const token of findMentionTokens(text)) {
    const item = roster.find(entry => entry.label === token.label)
    if (!item) continue

    // Take the space that follows the token with it, so "ask @X for help"
    // reads "ask for help" rather than leaving a gap.
    const resumeAt = text[token.end] === ' ' ? token.end + 1 : token.end
    const stripped = text.slice(0, token.start) + text.slice(resumeAt)

    return { strippedText: normalizeSpacing(stripMentionMarkers(stripped)), target: item }
  }

  return { strippedText: normalizeSpacing(stripMentionMarkers(text)), target: null }
}
