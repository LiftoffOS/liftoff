// The seam between a streaming reply and the voice that reads it.
//
// What matters here is that each word is spoken exactly once: the hook receives
// the whole reply-so-far on every token, and forwarding that verbatim would read
// the reply back N times, growing each time.

import { renderHook, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useSpokenReplies } from './useSpokenReplies'

const said: string[] = []
const ended = vi.fn()
const stopped = vi.fn()

/**
 * Every session opened, with a way to say its audio has finished playing.
 *
 * Real sessions report that themselves, some seconds after `end`. Tests need
 * the moment to be theirs, because what happens between "told to stop" and
 * "actually silent" is where most of this hook's behaviour lives.
 */
const sessions: { finishPlayout: () => void }[] = []

vi.mock('../services/voiceSpeech', () => ({
  SpeechSession: {
    open: vi.fn(async (options: { onFinished?: () => void }) => {
      let isEnding = false
      sessions.push({ finishPlayout: () => options.onFinished?.() })
      return {
        say: (text: string) => {
          if (!isEnding) said.push(text)
        },
        end: () => {
          isEnding = true
          ended()
        },
        stop: () => stopped(),
        get speaking() {
          return true
        },
        get ending() {
          return isEnding
        },
      }
    }),
  },
}))

const BASE = { tenantId: 'tenant-1', surface: 'agent_chat' as const, agentId: 'agent-1' }

beforeEach(() => {
  said.length = 0
  sessions.length = 0
  ended.mockClear()
  stopped.mockClear()
  vi.useRealTimers()
})

describe('useSpokenReplies', () => {
  it('speaks each new piece of the reply exactly once', async () => {
    const { rerender } = renderHook(
      ({ text }: { text: string | null }) =>
        useSpokenReplies({ ...BASE, enabled: true, assistantText: text }),
      { initialProps: { text: 'Your pipeline' as string | null } },
    )

    await waitFor(() => expect(said.length).toBeGreaterThan(0))
    rerender({ text: 'Your pipeline review' })
    rerender({ text: 'Your pipeline review is ready.' })

    await waitFor(() => expect(said.join('')).toBe('Your pipeline review is ready.'))
    // Not "Your pipelineYour pipeline reviewYour pipeline review is ready."
    expect(said.join('')).not.toContain('Your pipeline review is ready.Your')
  })

  it('says nothing at all when the toggle is off', async () => {
    const { rerender } = renderHook(
      ({ text }: { text: string | null }) =>
        useSpokenReplies({ ...BASE, enabled: false, assistantText: text }),
      { initialProps: { text: 'Something' as string | null } },
    )
    rerender({ text: 'Something longer' })
    await waitFor(() => expect(said).toEqual([]))
  })

  it('ends the session when the reply finishes', async () => {
    const { rerender } = renderHook(
      ({ text }: { text: string | null }) =>
        useSpokenReplies({ ...BASE, enabled: true, assistantText: text }),
      { initialProps: { text: 'All done.' as string | null } },
    )
    await waitFor(() => expect(said.length).toBeGreaterThan(0))
    rerender({ text: null })
    await waitFor(() => expect(ended).toHaveBeenCalled())
  })

  it('silences a reply in progress when the toggle goes off', async () => {
    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useSpokenReplies({ ...BASE, enabled, assistantText: 'Speaking now.' }),
      { initialProps: { enabled: true } },
    )
    await waitFor(() => expect(said.length).toBeGreaterThan(0))
    rerender({ enabled: false })
    await waitFor(() => expect(stopped).toHaveBeenCalled())
  })

  it('can still be interrupted while the finished reply plays out', async () => {
    // The window between "the text stopped arriving" and "the audio stopped
    // coming out" is exactly when a person interrupts. Losing the session
    // reference at `end` would make the hook report silence and send the
    // barge-in nowhere.
    const { result, rerender } = renderHook(
      ({ text }: { text: string | null }) =>
        useSpokenReplies({ ...BASE, enabled: true, assistantText: text }),
      { initialProps: { text: 'A long reply that is still playing.' as string | null } },
    )
    await waitFor(() => expect(said.length).toBeGreaterThan(0))
    rerender({ text: null })
    await waitFor(() => expect(ended).toHaveBeenCalled())

    expect(result.current.isSpeaking()).toBe(true)
    result.current.stop()
    expect(stopped).toHaveBeenCalled()
  })

  it('supersedes a reply still playing out when the next one starts', async () => {
    const { rerender } = renderHook(
      ({ text }: { text: string | null }) =>
        useSpokenReplies({ ...BASE, enabled: true, assistantText: text }),
      { initialProps: { text: 'First reply.' as string | null } },
    )
    await waitFor(() => expect(said.length).toBeGreaterThan(0))
    rerender({ text: null })
    await waitFor(() => expect(ended).toHaveBeenCalled())
    said.length = 0

    // A session that has been told to end refuses new text. Without opening a
    // fresh one, the next reply would be silent.
    rerender({ text: 'Second reply.' })
    await waitFor(() => expect(said.join('')).toBe('Second reply.'))
  })

  it('starts a fresh reply over rather than continuing the last one', async () => {
    const { rerender } = renderHook(
      ({ text }: { text: string | null }) =>
        useSpokenReplies({ ...BASE, enabled: true, assistantText: text }),
      { initialProps: { text: 'First reply is long.' as string | null } },
    )
    await waitFor(() => expect(said.length).toBeGreaterThan(0))
    said.length = 0
    // Shorter than what came before: a new reply reusing the same slot, not a
    // rewind. Slicing by the old offset here would drop its opening words.
    rerender({ text: 'Second.' })
    await waitFor(() => expect(said.join('')).toBe('Second.'))
  })

  // A run that spends forty seconds in its tools is forty seconds of silence,
  // and silence in a voice conversation reads as a fault rather than as work.
  describe('spoken progress', () => {
    function narrating(initial: { text: string | null; activity: string | null }) {
      return renderHook(
        ({ text, activity }: { text: string | null; activity: string | null }) =>
          useSpokenReplies({ ...BASE, enabled: true, assistantText: text, activity }),
        { initialProps: initial },
      )
    }

    /** Progress lines carry a trailing space so a reply buffered behind one
     *  does not run into it. That is a joining detail, not the words. */
    const spoken = () => said.map((line) => line.trim())

    it('says what the team is doing while the reply is still empty', async () => {
      narrating({ text: '', activity: 'Checking connected apps' })
      await waitFor(() => expect(spoken()).toEqual(['Checking connected apps.']))
      // Said and played out, not held open: the answer must never queue behind
      // a session kept alive for filler.
      expect(ended).toHaveBeenCalled()
    })

    it('does not say the same step twice', async () => {
      const { rerender } = narrating({ text: '', activity: 'Recalling context' })
      await waitFor(() => expect(said).toHaveLength(1))

      sessions[0].finishPlayout()
      rerender({ text: '', activity: 'Recalling context' })
      await waitFor(() => expect(said).toHaveLength(1))
    })

    it('leaves a gap before saying the next one', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const { rerender } = narrating({ text: '', activity: 'Recalling context' })
      await waitFor(() => expect(said).toHaveLength(1))
      sessions[0].finishPlayout()

      // Four tools in six seconds is not four things worth saying.
      rerender({ text: '', activity: 'Checking connected apps' })
      await waitFor(() => expect(said).toHaveLength(1))

      vi.advanceTimersByTime(7000)
      rerender({ text: '', activity: 'Reviewing your workspace' })
      await waitFor(() =>
        expect(spoken()).toEqual(['Recalling context.', 'Reviewing your workspace.']),
      )
    })

    it('never talks over the reply', async () => {
      const { rerender } = narrating({ text: 'Here is what I found.', activity: null })
      await waitFor(() => expect(said).toEqual(['Here is what I found.']))

      // More tools mid-answer. The answer is what the person is listening to.
      rerender({ text: 'Here is what I found.', activity: 'Checking connected apps' })
      await waitFor(() => expect(said).toEqual(['Here is what I found.']))
    })

    it('gives way the moment the answer arrives', async () => {
      const { rerender } = narrating({ text: '', activity: 'Drafting the plan' })
      await waitFor(() => expect(spoken()).toEqual(['Drafting the plan.']))

      rerender({ text: 'The plan is ready.', activity: 'Drafting the plan' })
      // A played-out session refuses new text, so the reply takes a fresh one
      // rather than being swallowed by the line that was still finishing.
      await waitFor(() => expect(said).toContain('The plan is ready.'))
      expect(stopped).toHaveBeenCalled()
    })

    it('says nothing at all when the toggle is off', async () => {
      renderHook(() =>
        useSpokenReplies({
          ...BASE,
          enabled: false,
          assistantText: '',
          activity: 'Checking connected apps',
        }),
      )
      await waitFor(() => expect(said).toEqual([]))
    })
  })
})
