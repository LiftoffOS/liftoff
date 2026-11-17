// Everything voice does on a chat surface, wired once.
//
// Three pages had their own copies of this: the microphone, the dictation
// session, and — on exactly one of them — spoken replies, conversation mode and
// barge-in. Sharing only the CSS is what let the three drift apart, so the
// behaviour lives here and the pages say what they are rather than how voice
// works.
//
// The two controls are orthogonal axes, which is why this needs no mode matrix.
// The microphone is the input modality; the header toggle is the output
// modality. With the toggle off the microphone dictates into the composer and
// the person presses send. With it on, the microphone starts a conversation:
// the recogniser decides the utterance is over, it sends itself, the reply is
// spoken, and it listens again.

import { useCallback, useEffect, useRef, useState } from 'react'

/**
 * How long a held reply waits for the recogniser to say what the noise was.
 *
 * Long enough to cover the gap between hearing a sound and settling the words
 * that followed it; short enough that a reply held by a false alarm resumes
 * before anyone decides it has crashed.
 */
const HOLD_TIMEOUT_MS = 1500

/**
 * How long an interruption waits for the run it killed to actually die.
 *
 * Aborting is a request, not an event: the runtime records an abort signal and
 * the engine winds down when it notices. Until it does, the thread still has an
 * invocation with no `completed_at`, and the runtime folds any new message into
 * that dying run instead of starting a turn — so the interruption lands
 * nowhere and is never answered. The stream closing is the run ending, so that
 * is what this waits for. The timer is only for a stream that never closes: an
 * interruption delivered late beats one that silently disappears.
 */
const ABORT_SETTLE_TIMEOUT_MS = 2000
import { useDictation, type DictationSurface, type ListenMode } from './useDictation'
import { useSpokenReplies } from './useSpokenReplies'

export interface UseVoiceChatOptions {
  tenantId: string | undefined
  /** Which chat this is. Decides who pays, so it is declared, never inferred. */
  surface: DictationSurface
  /** `internal_agents.id`, when the surface has one. */
  agentId?: string
  /** The composer's current text. */
  composerText: string
  setComposerText: (text: string) => void
  /** The reply so far, or null when none is streaming. */
  assistantText: string | null
  /**
   * What the team is doing right now, in the same words the activity line uses,
   * or null when it is not working.
   *
   * Spoken, never written. A run that spends its first forty seconds in tools
   * says so, because in a voice conversation a long silence reads as a fault.
   */
  activity?: string | null
  /** Send whatever is in the composer, exactly as the send button would. */
  onSend: () => void
  /**
   * Abort the run in flight, if the surface can.
   *
   * Barge-in needs this: stopping only the audio would leave the turn running,
   * finishing, and billing for a reply nobody heard. A surface without a stop
   * still gets voice — it just cannot cut a reply short.
   */
  onStopRun?: () => void
  onError: (message: string) => void
}

export interface UseVoiceChatResult {
  /** Microphone armed. */
  isListening: boolean
  toggleListening: () => void
  /** Replies are spoken. */
  isVoiceMode: boolean
  toggleVoiceMode: () => void
  /** How loud the person is, 0 to 1, read from an animation frame. */
  levelRef: React.RefObject<number>
  /**
   * What the composer should say while the microphone is armed, or null to
   * leave the page's own wording alone.
   *
   * The placeholder is visible exactly when the composer is empty, which is
   * exactly the moment between turns when somebody needs to know whether this
   * is listening and whether they are expected to do anything about it.
   */
  placeholder: string | null
}

export function useVoiceChat({
  tenantId,
  surface,
  agentId,
  composerText,
  setComposerText,
  assistantText,
  activity,
  onSend,
  onStopRun,
  onError,
}: UseVoiceChatOptions): UseVoiceChatResult {
  const [isVoiceMode, setIsVoiceMode] = useState(false)

  const composerTextRef = useRef(composerText)
  const onSendRef = useRef(onSend)
  const onStopRunRef = useRef(onStopRun)
  // In an effect, not during render: these are read from listeners and timers
  // that outlive the render which created them, so after commit is early
  // enough, and a ref must not be written while rendering.
  useEffect(() => {
    composerTextRef.current = composerText
    onSendRef.current = onSend
    onStopRunRef.current = onStopRun
  })

  const speech = useSpokenReplies({
    enabled: isVoiceMode,
    tenantId,
    surface,
    ...(agentId ? { agentId } : {}),
    assistantText,
    activity: activity ?? null,
    onError,
  })

  /**
   * Someone MIGHT be interrupting.
   *
   * Provisional on purpose. This fires on the first words the recogniser reports,
   * and those words are as often a keyboard or a chair as a person — so the reply
   * is only turned down, and the agent's run is left alone.
   */
  const holdTimerRef = useRef<number | null>(null)

  const releaseHold = useCallback(() => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }
    speech.unduck()
  }, [speech])

  const handleSpeechStart = useCallback(() => {
    if (!speech.isSpeaking()) return
    speech.duck()
    // Safety net. The recogniser does not always tell us a noise came to
    // nothing — it may simply never mention it again — and a reply left quiet
    // forever is nearly as bad as one that stopped.
    if (holdTimerRef.current !== null) window.clearTimeout(holdTimerRef.current)
    holdTimerRef.current = window.setTimeout(() => {
      holdTimerRef.current = null
      speech.unduck()
    }, HOLD_TIMEOUT_MS)
  }, [speech])

  /** It was nothing. Carry on mid-sentence. */
  const handleSpeechDiscarded = useCallback(() => {
    releaseHold()
  }, [releaseHold])

  /**
   * A real interruption, confirmed by actual words.
   *
   * Returns whether a RUN was aborted, which is not the same as whether audio
   * was stopped. The audio always stops: somebody is talking. Whether the work
   * behind it should die depends entirely on what they cut off.
   *
   * Cutting off the ANSWER is a rejection. The run has to go, because stopping
   * the audio alone would leave it running, completing, and billing for a reply
   * nobody heard.
   *
   * Cutting off a PROGRESS LINE is the opposite. The team is thirty seconds into
   * its tools and the person is adding to that work, not refusing it. Killing
   * the run there would throw away everything it has done, so the words are
   * delivered into the run instead and it carries on.
   */
  const commitBargeIn = useCallback((): boolean => {
    if (holdTimerRef.current !== null) {
      window.clearTimeout(holdTimerRef.current)
      holdTimerRef.current = null
    }
    if (!speech.isSpeaking()) return false
    const interrupted = speech.speakingKind()
    speech.stop()
    if (interrupted === 'progress') return false
    onStopRunRef.current?.()
    return true
  }, [speech])

  // A finished utterance goes through the composer and the ordinary send path,
  // so a spoken turn is indistinguishable from a typed one downstream.
  //
  // It cannot be sent in the same breath as it is set: the send path reads the
  // composer from its own closure, which still holds the previous value. So the
  // turn is counted, and the effect below sends once React has re-rendered with
  // the words in the composer.
  //
  // COUNTED, not compared against the composer's text. Waiting for the composer
  // to equal the utterance sounds equivalent and is not: the composer has been
  // showing those words since the interims landed, so writing the utterance into
  // it usually sets state to the value it already holds. React compares effect
  // dependencies by value, an unchanged string is not a change, and the effect
  // never runs. The turn that reproduced this every time is the shortest one —
  // a single settled segment, nothing typed beforehand — which is most of what
  // anyone says out loud. A counter changes on every turn by construction,
  // including the second identical one.
  const [turnCount, setTurnCount] = useState(0)

  /**
   * A run was aborted and has not finished dying yet.
   *
   * Sticky until the turn is actually sent. Someone who keeps talking produces
   * more utterances while the first abort is still settling, and every one of
   * them has to keep waiting: `commitBargeIn` returns false for them (the audio
   * is already stopped, so there is nothing left to interrupt) and without this
   * the second utterance would go out immediately, straight into the dying run
   * the first one killed.
   */
  const abortedRunRef = useRef(false)
  /** The last turn actually handed to the send path, so none goes twice. */
  const sentTurnRef = useRef(0)

  const handleUtterance = useCallback(
    (text: string, corroborated: boolean) => {
      // Only the room may end a reply.
      //
      // The recogniser alone is not enough, and letting it decide is what made
      // a reply stop dead at a noise: it hears ordinary short words in a noisy
      // room, and one of them used to stop the audio for good and abort the run
      // behind it. Words it produced with no voice to back them up are still
      // SENT, because a person too quiet to register is a person whose words
      // must not be thrown away — they just do not get to interrupt anything on
      // their way through.
      if (corroborated && commitBargeIn()) abortedRunRef.current = true
      setComposerText(text)
      setTurnCount((count) => count + 1)
    },
    [setComposerText, commitBargeIn],
  )

  useEffect(() => {
    if (turnCount === 0 || sentTurnRef.current === turnCount) return

    // Both updates land in one render, so the composer holds the utterance and
    // `onSendRef` has been repointed at the send closure that can see it.
    const send = () => {
      sentTurnRef.current = turnCount
      abortedRunRef.current = false
      onSendRef.current()
    }

    // Nothing was killed, so nothing is dying. Go now.
    if (!abortedRunRef.current) {
      send()
      return
    }

    // A run was aborted. Sending into the window before it finishes dying is
    // the whole bug: the runtime still sees an invocation with no `completed_at`
    // on this thread and folds the interruption into it, so the words land in a
    // run that is on its way out and are never answered. `assistantText` going
    // null IS the stream closing, and the runtime writes `completed_at` before
    // that happens, so by then the thread is genuinely idle and the ordinary
    // send path starts a new turn.
    if (assistantText === null) {
      send()
      return
    }

    const timer = window.setTimeout(send, ABORT_SETTLE_TIMEOUT_MS)
    return () => window.clearTimeout(timer)
  }, [turnCount, assistantText])

  const listenMode: ListenMode = isVoiceMode ? 'conversation' : 'dictation'

  const { isListening, toggle, start, stop, levelRef } = useDictation({
    tenantId,
    surface,
    ...(agentId ? { agentId } : {}),
    getComposerText: () => composerTextRef.current,
    setComposerText,
    onError,
    mode: listenMode,
    onUtterance: handleUtterance,
    onSpeechStart: handleSpeechStart,
    onSpeechDiscarded: handleSpeechDiscarded,
  })

  const toggleListening = useCallback(() => {
    void toggle()
  }, [toggle])

  const toggleVoiceMode = useCallback(() => {
    setIsVoiceMode((enabled) => !enabled)
  }, [])

  /**
   * Voice mode arms the microphone by itself.
   *
   * Voice mode IS voice-to-voice, so requiring a second press on the microphone
   * to actually start talking was never the design — the toggle promised a
   * conversation and then waited for a button.
   *
   * Turning it on while the microphone is already armed for dictation still
   * restarts it: the mode travels in the socket URL, so an existing session is
   * listening under the old rules and cannot be converted in place.
   */
  const listeningRef = useRef(isListening)
  useEffect(() => { listeningRef.current = isListening })

  const isFirstRenderRef = useRef(true)
  useEffect(() => {
    // Nothing to do on mount: voice mode starts off, and arming a microphone
    // because a page loaded would be its own bug.
    if (isFirstRenderRef.current) {
      isFirstRenderRef.current = false
      return
    }
    if (isVoiceMode) {
      if (listeningRef.current) stop()
      void start()
    } else if (listeningRef.current) {
      stop()
    }
    // Deliberately keyed on the mode alone. Including `isListening` would make
    // this fire on every arm and disarm and fight the person using the button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isVoiceMode])

  // Two sentences, because the two modes ask different things of the person.
  // In conversation nobody should be looking for a button, so the placeholder
  // says what ends a turn; in dictation the button is still the point.
  const placeholder = !isListening
    ? null
    : isVoiceMode
      ? 'Listening. Pause when you are done.'
      : 'Listening. Press send when you are done.'

  return {
    isListening,
    toggleListening,
    isVoiceMode,
    toggleVoiceMode,
    levelRef,
    placeholder,
  }
}
