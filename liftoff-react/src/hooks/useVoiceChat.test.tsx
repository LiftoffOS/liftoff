// Voice mode's two promises: the microphone is live, and a noise is not an
// interruption.
//
// Both were broken on first ship. Turning voice mode on left the person to press
// the microphone separately, and the first interim transcript — a cough, a door,
// a passing conversation — hard-stopped the reply AND aborted the agent's run,
// irreversibly.

import { useState } from 'react'
import { render, renderHook, act, waitFor } from '@testing-library/react'
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { useVoiceChat } from './useVoiceChat'

const dictation = {
  onUtterance: undefined as ((t: string, corroborated: boolean) => void) | undefined,
  onSpeechStart: undefined as (() => void) | undefined,
  onSpeechDiscarded: undefined as (() => void) | undefined,
  setComposerText: undefined as ((t: string) => void) | undefined,
  listening: false,
  start: vi.fn(async () => { dictation.listening = true }),
  stop: vi.fn(() => { dictation.listening = false }),
  toggle: vi.fn(async () => {}),
}

const speech = {
  stop: vi.fn(),
  duck: vi.fn(),
  unduck: vi.fn(),
  speaking: true,
  /** What the voice is saying: an answer, or a line about work in progress. */
  kind: 'reply' as 'reply' | 'progress',
}

vi.mock('./useDictation', () => ({
  useDictation: (opts: Record<string, unknown>) => {
    dictation.onUtterance = opts.onUtterance as (t: string, corroborated: boolean) => void
    dictation.onSpeechStart = opts.onSpeechStart as () => void
    dictation.onSpeechDiscarded = opts.onSpeechDiscarded as () => void
    dictation.setComposerText = opts.setComposerText as (t: string) => void
    return {
      isListening: dictation.listening,
      toggle: dictation.toggle,
      start: dictation.start,
      stop: dictation.stop,
    }
  },
}))

vi.mock('./useSpokenReplies', () => ({
  useSpokenReplies: () => ({
    stop: speech.stop,
    duck: speech.duck,
    unduck: speech.unduck,
    isSpeaking: () => speech.speaking,
    speakingKind: () => (speech.speaking ? speech.kind : null),
  }),
}))

const onStopRun = vi.fn()

function setup() {
  return renderHook(() =>
    useVoiceChat({
      tenantId: 'tenant-1',
      surface: 'agent_chat',
      agentId: 'agent-1',
      composerText: '',
      setComposerText: () => {},
      assistantText: null,
      onSend: () => {},
      onStopRun,
      onError: () => {},
    }),
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.useRealTimers()
  speech.speaking = true
  speech.kind = 'reply'
  dictation.listening = false
})

describe('useVoiceChat', () => {
  it('arms the microphone when voice mode is turned on', async () => {
    const { result } = setup()
    expect(dictation.start).not.toHaveBeenCalled()

    act(() => result.current.toggleVoiceMode())

    // Voice mode IS voice-to-voice. Waiting for a second press on the
    // microphone was the bug.
    await waitFor(() => expect(dictation.start).toHaveBeenCalled())
  })

  it('disarms it again when voice mode is turned off', async () => {
    const { result } = setup()
    act(() => result.current.toggleVoiceMode())
    await waitFor(() => expect(dictation.start).toHaveBeenCalled())
    act(() => result.current.toggleVoiceMode())
    await waitFor(() => expect(dictation.stop).toHaveBeenCalled())
  })

  it('does not arm anything just because the page rendered', () => {
    setup()
    expect(dictation.start).not.toHaveBeenCalled()
    expect(dictation.stop).not.toHaveBeenCalled()
  })

  it('only TURNS DOWN the reply when a sound might be speech', () => {
    setup()
    act(() => dictation.onSpeechStart?.())

    // Ducked, reversibly. The run is untouched: a cough must not abort the
    // agent, and a gain change cannot strand the reply the way suspending the
    // audio clock could.
    expect(speech.duck).toHaveBeenCalled()
    expect(speech.stop).not.toHaveBeenCalled()
    expect(onStopRun).not.toHaveBeenCalled()
  })

  it('comes back to full mid-sentence when the sound came to nothing', () => {
    setup()
    act(() => dictation.onSpeechStart?.())
    act(() => dictation.onSpeechDiscarded?.())

    expect(speech.unduck).toHaveBeenCalled()
    expect(speech.stop).not.toHaveBeenCalled()
    expect(onStopRun).not.toHaveBeenCalled()
  })

  it('comes back by itself if the recogniser never explains the noise', () => {
    vi.useFakeTimers()
    setup()
    act(() => dictation.onSpeechStart?.())
    expect(speech.unduck).not.toHaveBeenCalled()

    // A reply left quiet forever is nearly as bad as one that stopped.
    act(() => { vi.advanceTimersByTime(2000) })
    expect(speech.unduck).toHaveBeenCalled()
  })

  it('ends the reply and aborts the run once real words arrive', () => {
    setup()
    act(() => dictation.onSpeechStart?.())
    act(() => dictation.onUtterance?.('actually, show me last quarter instead', true))

    expect(speech.stop).toHaveBeenCalled()
    // Stopping only the audio would leave the turn running, completing, and
    // billing for a reply nobody heard.
    expect(onStopRun).toHaveBeenCalled()
  })

  // The turn has to reach the send path, not just the composer. These drive a
  // REAL composer — one useState, the way a page holds it — because the bug
  // being guarded lives in the difference between setting state and changing it.
  describe('the spoken turn sends itself', () => {
    function Composer({ onSend }: { onSend: (sent: string) => void }) {
      const [text, setText] = useState('')
      useVoiceChat({
        tenantId: 'tenant-1',
        surface: 'agent_chat',
        agentId: 'agent-1',
        composerText: text,
        setComposerText: setText,
        assistantText: null,
        // Reads the composer out of its own closure, exactly as every page's
        // send handler does. Sending one render too early sends the wrong words.
        onSend: () => onSend(text),
        onStopRun,
        onError: () => {},
      })
      return <span data-testid="composer">{text}</span>
    }

    /**
     * What `useDictation` actually does when a turn ends, in the order and the
     * tick it does it: the composer is cleared and the utterance handed over,
     * both inside one callback.
     */
    function speak(text: string) {
      act(() => { dictation.setComposerText?.(text) })
      act(() => {
        dictation.setComposerText?.('')
        dictation.onUtterance?.(text, true)
      })
    }

    it('sends a turn whose words are already in the composer', () => {
      const onSend = vi.fn()
      render(<Composer onSend={onSend} />)

      // The composer has been showing these words since the interim landed.
      // That is the ordinary case, not an edge one.
      speak('what is the weather')

      expect(onSend).toHaveBeenCalledTimes(1)
      expect(onSend).toHaveBeenCalledWith('what is the weather')
    })

    it('sends a second turn that repeats the first word for word', () => {
      const onSend = vi.fn()
      render(<Composer onSend={onSend} />)
      speak('say that again')
      speak('say that again')

      expect(onSend).toHaveBeenCalledTimes(2)
    })
  })

  // The composer's own placeholder is the only thing on screen that can say
  // what is expected of the person, and it is visible exactly when they are
  // between turns and wondering.
  describe('what the composer says while armed', () => {
    it('says nothing of its own while the microphone is off', () => {
      const { result } = setup()
      expect(result.current.placeholder).toBeNull()
    })

    it('tells a conversation that pausing is what sends', async () => {
      const { result } = setup()
      dictation.listening = true
      act(() => result.current.toggleVoiceMode())
      await waitFor(() => expect(dictation.start).toHaveBeenCalled())

      expect(result.current.placeholder).toBe('Listening. Pause when you are done.')
    })

    it('still points at the button when only dictating', async () => {
      dictation.listening = true
      const { result, rerender } = setup()
      rerender()

      expect(result.current.placeholder).toBe('Listening. Press send when you are done.')
    })
  })

  // Aborting is a request, not an event. The runtime records an abort signal
  // and the engine winds down when it notices; until it does, the thread still
  // holds an invocation with no `completed_at` and the runtime folds any new
  // message into that dying run. An interruption sent into that window is never
  // answered, which is the whole of this bug.
  describe('an interruption waits for the run it killed', () => {
    function interrupting(initialAssistantText: string | null) {
      const onSend = vi.fn()
      const view = renderHook(
        ({ assistantText }: { assistantText: string | null }) =>
          useVoiceChat({
            tenantId: 'tenant-1',
            surface: 'agent_chat',
            agentId: 'agent-1',
            composerText: '',
            setComposerText: () => {},
            assistantText,
            onSend,
            onStopRun,
            onError: () => {},
          }),
        { initialProps: { assistantText: initialAssistantText } },
      )
      return { ...view, onSend }
    }

    it('holds the words until the aborted run has actually ended', () => {
      const { rerender, onSend } = interrupting('Here is the pipeline reviE')
      act(() => dictation.onUtterance?.('actually, show me last quarter', true))

      expect(onStopRun).toHaveBeenCalled()
      // Sending now is what put the interruption into a run on its way out.
      expect(onSend).not.toHaveBeenCalled()

      // The stream closing is the run ending, and the runtime has written
      // `completed_at` by then, so the thread is idle and this starts a turn.
      rerender({ assistantText: null })
      expect(onSend).toHaveBeenCalledTimes(1)
    })

    it('sends once and only once', () => {
      const { rerender, onSend } = interrupting('A reply in progress')
      act(() => dictation.onUtterance?.('never mind', true))
      rerender({ assistantText: null })
      // The next run opens with an empty string, which must not look like a
      // second chance to send the turn that already went.
      rerender({ assistantText: '' })
      rerender({ assistantText: 'The next reply' })

      expect(onSend).toHaveBeenCalledTimes(1)
    })

    it('keeps waiting when the person carries on talking', () => {
      const { rerender, onSend } = interrupting('A reply in progress')
      act(() => dictation.onUtterance?.('actually', true))
      // The audio is already stopped, so this second utterance interrupts
      // nothing — but the run it killed is still dying, and going now would
      // land in it.
      speech.speaking = false
      act(() => dictation.onUtterance?.('show me last quarter instead', true))
      expect(onSend).not.toHaveBeenCalled()

      rerender({ assistantText: null })
      expect(onSend).toHaveBeenCalledTimes(1)
    })

    it('gives up waiting rather than losing the interruption', () => {
      vi.useFakeTimers()
      const { onSend } = interrupting('A reply that never finishes')
      act(() => dictation.onUtterance?.('stop and do this instead', true))
      expect(onSend).not.toHaveBeenCalled()

      // A stop request can fail. Late beats silently discarded.
      act(() => { vi.advanceTimersByTime(2000) })
      expect(onSend).toHaveBeenCalledTimes(1)
    })

    it('leaves the reply playing when the room never backed up the words', () => {
      // The recogniser produced a sentence the microphone did not hear anybody
      // say. It is still delivered, because a person too quiet to register is
      // not a person whose words may be dropped — but it does not get to stop
      // an answer mid-sentence on the strength of a noise.
      const { onSend } = interrupting('A reply that should keep playing')
      act(() => dictation.onUtterance?.('was that the final number', false))

      expect(speech.stop).not.toHaveBeenCalled()
      expect(onStopRun).not.toHaveBeenCalled()
      expect(onSend).toHaveBeenCalledTimes(1)
    })

    it('does not wait at all when no run was killed', () => {
      speech.speaking = false
      const { onSend } = interrupting('A reply in progress')
      act(() => dictation.onUtterance?.('a question while it works', true))

      expect(onStopRun).not.toHaveBeenCalled()
      expect(onSend).toHaveBeenCalledTimes(1)
    })

    it('steers the run when what was interrupted was a progress line', () => {
      // Thirty seconds into its tools, saying so out loud. Talking over that is
      // the person adding to the work, not rejecting an answer that does not
      // exist yet — killing the run would throw all of it away.
      speech.kind = 'progress'
      const { onSend } = interrupting('')
      act(() => dictation.onUtterance?.('and include contractors', true))

      expect(speech.stop).toHaveBeenCalled()
      expect(onStopRun).not.toHaveBeenCalled()
      expect(onSend).toHaveBeenCalledTimes(1)
    })
  })

  it('does not touch a reply that is not being spoken', () => {
    speech.speaking = false
    setup()
    act(() => dictation.onSpeechStart?.())
    expect(speech.duck).not.toHaveBeenCalled()
  })
})
