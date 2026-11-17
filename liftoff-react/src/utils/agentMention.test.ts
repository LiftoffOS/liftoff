import { describe, it, expect } from 'vitest'
import {
  MENTION_CLOSE,
  MENTION_OPEN,
  SPECIAL_MENTION_ITEMS,
  buildMentionRoster,
  findMentionTokens,
  findOpenMentionSpan,
  makeMentionToken,
  mentionTokenAfterCaret,
  mentionTokenBeforeCaret,
  parseAgentMention,
  stripMentionMarkers,
  toMentionListItems,
  type MentionRosterItem,
} from './agentMention'

const roster: MentionRosterItem[] = [...SPECIAL_MENTION_ITEMS]

/** Composer text as it exists after the person picks "label" from the picker. */
const mention = (label: string) => makeMentionToken(label)

describe('makeMentionToken', () => {
  it('brackets the label with the invisible delimiters', () => {
    expect(mention('Liftoff')).toBe(`${MENTION_OPEN}@Liftoff${MENTION_CLOSE}`)
  })

  it('adds no visible characters beyond the @ and the label', () => {
    expect(stripMentionMarkers(mention('Insights Manager'))).toBe('@Insights Manager')
  })
})

describe('findMentionTokens', () => {
  it('finds a token and reports the span covering the whole thing', () => {
    const text = `ask ${mention('Liftoff')} please`
    const [token] = findMentionTokens(text)

    expect(token.label).toBe('Liftoff')
    expect(text.slice(token.start, token.end)).toBe(mention('Liftoff'))
  })

  it('finds every token in order', () => {
    const text = `${mention('Liftoff')} then ${mention('Insights Manager')}`
    expect(findMentionTokens(text).map(t => t.label)).toEqual(['Liftoff', 'Insights Manager'])
  })

  it('keeps labels containing spaces intact', () => {
    const text = mention('Release Coordinator')
    expect(findMentionTokens(text)[0].label).toBe('Release Coordinator')
  })

  it('ignores bare @text that was typed rather than picked', () => {
    expect(findMentionTokens('ask @Liftoff please')).toEqual([])
  })

  it('ignores a token whose closing delimiter was deleted', () => {
    expect(findMentionTokens(`ask ${MENTION_OPEN}@Liftoff please`)).toEqual([])
  })

  it('ignores a token whose opening delimiter was deleted', () => {
    expect(findMentionTokens(`ask @Liftoff${MENTION_CLOSE} please`)).toEqual([])
  })

  it('still finds an intact token after an orphaned opening delimiter', () => {
    const text = `${MENTION_OPEN}stray ${mention('Liftoff')}`
    expect(findMentionTokens(text).map(t => t.label)).toEqual(['Liftoff'])
  })
})

describe('stripMentionMarkers', () => {
  it('leaves the text as the person sees it', () => {
    expect(stripMentionMarkers(`ask ${mention('Liftoff')} please`)).toBe('ask @Liftoff please')
  })

  it('removes orphaned delimiters so none can reach the backend', () => {
    expect(stripMentionMarkers(`a${MENTION_OPEN}b${MENTION_CLOSE}c${MENTION_OPEN}`)).toBe('abc')
  })
})

describe('mentionTokenBeforeCaret / mentionTokenAfterCaret', () => {
  const text = `${mention('Liftoff')} hi`
  const [token] = findMentionTokens(text)

  it('claims a Backspace with the caret immediately after the token', () => {
    expect(mentionTokenBeforeCaret(text, token.end)?.label).toBe('Liftoff')
  })

  it('claims a Backspace with the caret inside the token', () => {
    expect(mentionTokenBeforeCaret(text, token.start + 3)?.label).toBe('Liftoff')
  })

  it('leaves a Backspace alone when the caret is past the trailing space', () => {
    expect(mentionTokenBeforeCaret(text, token.end + 1)).toBeNull()
  })

  it('leaves a Backspace alone when the caret is before the token', () => {
    expect(mentionTokenBeforeCaret(text, token.start)).toBeNull()
  })

  it('claims a Delete with the caret immediately before the token', () => {
    expect(mentionTokenAfterCaret(text, token.start)?.label).toBe('Liftoff')
  })

  it('leaves a Delete alone when the caret is past the token', () => {
    expect(mentionTokenAfterCaret(text, token.end)).toBeNull()
  })
})

describe('findOpenMentionSpan', () => {
  it('finds an unterminated @mention at string start', () => {
    expect(findOpenMentionSpan('@Lif', 4)).toEqual({ atIndex: 0, caretIndex: 4, query: 'Lif' })
  })

  it('finds an unterminated @mention after whitespace', () => {
    expect(findOpenMentionSpan('ask @Lif for help', 8)?.atIndex).toBe(4)
  })

  it('finds an @mention after a newline', () => {
    expect(findOpenMentionSpan('first line\n@Chie', 16)?.atIndex).toBe(11)
  })

  it('returns null for an email-like address', () => {
    expect(findOpenMentionSpan('contact foo@bar.com now', 19)).toBeNull()
  })

  it('returns null when no @ is present', () => {
    expect(findOpenMentionSpan('hello there', 5)).toBeNull()
  })

  it('returns null for an invalid caret index', () => {
    expect(findOpenMentionSpan('@Lif', -1)).toBeNull()
    expect(findOpenMentionSpan('@Lif', 10)).toBeNull()
  })

  it('handles an empty query straight after the @', () => {
    expect(findOpenMentionSpan('ask @ something', 5)?.query).toBe('')
  })

  it('does not re-open on a completed token with the caret just after it', () => {
    const text = mention('Liftoff')
    expect(findOpenMentionSpan(text, text.length)).toBeNull()
  })

  it('does not re-open on a completed token with the caret inside it', () => {
    const text = mention('Liftoff')
    expect(findOpenMentionSpan(text, text.length - 1)).toBeNull()
  })

  it('still opens for a new mention typed after a completed one', () => {
    const text = `${mention('Liftoff')} @Ins`
    expect(findOpenMentionSpan(text, text.length)?.query).toBe('Ins')
  })
})

describe('parseAgentMention', () => {
  it('strips a leading token and routes to its target', () => {
    const { strippedText, target } = parseAgentMention(`${mention('Liftoff')} hello`, roster)
    expect(strippedText).toBe('hello')
    expect(target?.label).toBe('Liftoff')
  })

  it('strips a mid-sentence token without leaving a double space', () => {
    const { strippedText, target } = parseAgentMention(
      `ask ${mention('Chief AI Officer')} for help`,
      roster,
    )
    expect(strippedText).toBe('ask for help')
    expect(target?.kind).toBe('caio')
  })

  it('strips a trailing token', () => {
    const { strippedText, target } = parseAgentMention(`what is the team size ${mention('Insights Manager')}`, roster)
    expect(strippedText).toBe('what is the team size')
    expect(target?.kind).toBe('insights')
  })

  it('matches a label containing spaces exactly', () => {
    const teamRoster = buildMentionRoster([{ id: 'team-1', role: 'Release Coordinator' }])
    const { strippedText, target } = parseAgentMention(
      `${mention('Release Coordinator')} ship it`,
      teamRoster,
    )
    expect(strippedText).toBe('ship it')
    expect(target).toMatchObject({ kind: 'team', id: 'team-1' })
  })

  it('does not let one label shadow another that shares its prefix', () => {
    const overlapping = buildMentionRoster([
      { id: 'a', role: 'AI' },
      { id: 'b', role: 'AI Officer' },
    ])
    expect(parseAgentMention(`${mention('AI Officer')} respond`, overlapping).target?.id).toBe('b')
    expect(parseAgentMention(`${mention('AI')} respond`, overlapping).target?.id).toBe('a')
  })

  it('uses the first token when several are present', () => {
    const { target } = parseAgentMention(
      `${mention('Liftoff')} and ${mention('Chief AI Officer')} do this`,
      roster,
    )
    expect(target?.label).toBe('Liftoff')
  })

  it('returns a null target for bare @text that was never picked', () => {
    const { strippedText, target } = parseAgentMention('ask @Liftoff for help', roster)
    expect(strippedText).toBe('ask @Liftoff for help')
    expect(target).toBeNull()
  })

  it('keeps the text of a token whose team is no longer in the roster', () => {
    // Nothing to route to, so the words stay in the message rather than being
    // silently eaten; only the delimiters come off.
    const { strippedText, target } = parseAgentMention(`${mention('Ghost Team')} hello`, roster)
    expect(strippedText).toBe('@Ghost Team hello')
    expect(target).toBeNull()
  })

  it('returns a null target when no mention is present', () => {
    expect(parseAgentMention('hello there', roster)).toEqual({
      strippedText: 'hello there',
      target: null,
    })
  })

  it('never leaves a delimiter in the text it hands on', () => {
    const { strippedText } = parseAgentMention(
      `${MENTION_OPEN}orphan ${mention('Liftoff')} hello`,
      roster,
    )
    expect(strippedText).not.toMatch(/[⁢⁣]/)
  })

  it('yields empty text when the message was only a mention', () => {
    const { strippedText, target } = parseAgentMention(mention('Liftoff'), roster)
    expect(strippedText).toBe('')
    expect(target?.label).toBe('Liftoff')
  })
})

describe('buildMentionRoster', () => {
  it('includes all special mention items', () => {
    const built = buildMentionRoster([])
    expect(built.map(item => item.kind)).toEqual(['liftoff', 'caio', 'insights'])
  })

  it('appends custom teams using their role as the label', () => {
    const built = buildMentionRoster([{ id: 'team-1', role: 'Release Coordinator' }])
    expect(built).toHaveLength(4)
    expect(built[3]).toEqual({ kind: 'team', id: 'team-1', label: 'Release Coordinator' })
  })
})

describe('toMentionListItems', () => {
  it('converts the roster to the UI item shape', () => {
    expect(toMentionListItems(buildMentionRoster([]))).toEqual([
      { id: 'liftoff', label: 'Liftoff' },
      { id: 'caio', label: 'Chief AI Officer' },
      { id: 'insights', label: 'Insights Manager' },
    ])
  })
})
