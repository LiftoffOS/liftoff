// The question a paused turn asks now exists in two places for a moment: the
// local bubble rendered off the `awaiting_input` frame, and the persisted row
// that the stream's closing refetch brings back. These cover the hand-over
// between them, in both directions.

import { describe, it, expect } from 'vitest'
import { mergeAwaitingInputMessage } from './awaitingInputMerge'

const persisted = (role: string, content: string) => ({ role, content })

describe('mergeAwaitingInputMessage', () => {
  it('returns the transcript untouched when nothing is awaiting input', () => {
    const list = [persisted('user', 'hello')]
    expect(mergeAwaitingInputMessage(list, null)).toBe(list)
  })

  it('appends the question while the backend has not persisted it yet', () => {
    const list = [persisted('user', 'summarise my repos')]
    const asked = persisted('assistant', 'Which repositories?')

    expect(mergeAwaitingInputMessage(list, asked)).toEqual([...list, asked])
  })

  // The regression this exists for: the backend persists the question now, so
  // appending the local copy on top of the refetched row showed it twice.
  it('drops the local copy once the persisted row says the same thing', () => {
    const list = [
      persisted('user', 'summarise my repos'),
      persisted('assistant', 'Which repositories?'),
    ]
    const asked = persisted('assistant', 'Which repositories?')

    expect(mergeAwaitingInputMessage(list, asked)).toBe(list)
  })

  // Someone asking the same thing the agent asked must not suppress the
  // agent's question — role is half the match for exactly this reason.
  it('does not treat the person echoing the question as the agent having asked it', () => {
    const list = [persisted('user', 'Which repositories?')]
    const asked = persisted('assistant', 'Which repositories?')

    expect(mergeAwaitingInputMessage(list, asked)).toEqual([...list, asked])
  })

  it('keeps a second, different question distinct from an earlier persisted one', () => {
    const list = [persisted('assistant', 'Which repositories?')]
    const asked = persisted('assistant', 'Over what time range?')

    expect(mergeAwaitingInputMessage(list, asked)).toEqual([...list, asked])
  })
})
