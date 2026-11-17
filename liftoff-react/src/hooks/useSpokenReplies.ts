// Speaking replies aloud, driven by the text already on screen.
//
// The chat stream is the single source: this hook watches the assistant text
// grow and forwards only what is new. Text and speech therefore cannot drift,
// because there is nothing for them to drift between — one stream feeds both.
//
// A session lasts one reply. It opens when a reply starts arriving and closes
// when the reply is finished and the audio has played out, so nothing holds a
// socket open between turns.

import { useCallback, useEffect, useRef } from 'react'
import { SpeechSession } from '../services/voiceSpeech'
import type { DictationSurface } from './useDictation'

/**
 * The shortest gap between two spoken progress lines.
 *
 * A run that calls four tools in six seconds has nothing to say four times.
 * The point of narrating is to give a long silence a shape, not to read out an
 * activity log.
 */
const NARRATION_GAP_MS = 6000

export interface UseSpokenRepliesOptions {
  /** The header toggle. Off means never speak, and silences anything speaking. */
  enabled: boolean
  tenantId: string | undefined
  surface: DictationSurface
  agentId?: string
  /** The reply so far, or null when no reply is streaming. */
  assistantText: string | null
  /**
   * What the team is doing right now, in the words already on screen, or null.
   *
   * Spoken but never written: this is the same phrase the activity line shows,
   * said aloud so that a run which spends forty seconds in its tools is not
   * forty seconds of silence. Everything about it is subordinate to the reply.
   * It is never said over the top of one, and if the answer arrives mid-phrase
   * the answer wins.
   */
  activity?: string | null
  /** Fires when a spoken reply finishes, which is a conversation's cue to listen. */
  onFinished?: () => void
  onError?: (message: string) => void
}

/**
 * What the voice is currently saying.
 *
 * The two are interrupted for opposite reasons, so anything reacting to a
 * barge-in has to know which one it cut off. Cutting off `reply` rejects an
 * answer. Cutting off `progress` adds to work that is still going.
 */
export type SpokenKind = 'reply' | 'progress'

export interface UseSpokenRepliesResult {
  /** Cut the audio off for good. A confirmed interruption calls this. */
  stop: () => void
  /** Turn the reply down, reversibly, while it is unclear whether someone is talking. */
  duck: () => void
  /** It was nothing — back up to full, mid-sentence. */
  unduck: () => void
  /** Is audio playing or queued right now? */
  isSpeaking: () => boolean
  /** Which of the two is playing, or null when nothing is. */
  speakingKind: () => SpokenKind | null
}

export function useSpokenReplies({
  enabled,
  tenantId,
  surface,
  agentId,
  assistantText,
  activity,
  onFinished,
  onError,
}: UseSpokenRepliesOptions): UseSpokenRepliesResult {
  const sessionRef = useRef<SpeechSession | null>(null)
  /** How much of the current reply has been sent for speaking. */
  const spokenUpToRef = useRef(0)
  /** Guards against opening two sessions while the first is still connecting. */
  const openingRef = useRef(false)
  /** Text that arrived while the socket was still opening. */
  const pendingRef = useRef('')

  const onFinishedRef = useRef(onFinished)
  const onErrorRef = useRef(onError)
  // In an effect, not during render: these are read from listeners and timers
  // that outlive the render which created them, so after commit is early
  // enough, and a ref must not be written while rendering.
  useEffect(() => {
    onFinishedRef.current = onFinished
    onErrorRef.current = onError
  })
  // Read after an await, where the value that opened the session may already be
  // stale: somebody can turn the toggle off while the socket is connecting.
  const enabledRef = useRef(enabled)
  useEffect(() => { enabledRef.current = enabled })

  /** The last thing narrated, and when, so neither repeats. */
  const lastActivityRef = useRef<string | null>(null)
  const lastNarratedAtRef = useRef(0)
  /** Which of the two channels last put words into the session that is playing. */
  const speakingKindRef = useRef<SpokenKind | null>(null)

  const stop = useCallback(() => {
    sessionRef.current?.stop()
    sessionRef.current = null
    openingRef.current = false
    pendingRef.current = ''
    spokenUpToRef.current = 0
    speakingKindRef.current = null
  }, [])

  /**
   * Open a session and say something through it.
   *
   * Shared by the reply and by the progress line, because the buffering is the
   * subtle part: text can arrive while the socket is still connecting, and the
   * first version of this dropped it.
   *
   * `playOut` closes the session once it has said its piece, which is what a
   * progress line wants and a reply does not: a reply keeps its session open
   * for the next chunk of itself.
   */
  const openAndSay = useCallback(
    (text: string, playOut = false) => {
      if (!tenantId) return
      pendingRef.current += text
      if (openingRef.current) return
      openingRef.current = true

      void SpeechSession.open({
        tenantId,
        surface,
        ...(agentId ? { agentId } : {}),
        onFinished: () => {
          sessionRef.current = null
          speakingKindRef.current = null
          onFinishedRef.current?.()
        },
        onError: (message) => onErrorRef.current?.(message),
      })
        .then((opened) => {
          openingRef.current = false
          // Stopped while connecting: honour that rather than starting to talk.
          if (!enabledRef.current) {
            opened.stop()
            return
          }
          sessionRef.current = opened
          const buffered = pendingRef.current
          pendingRef.current = ''
          if (buffered) opened.say(buffered)
          if (playOut) opened.end()
        })
        .catch((err: Error) => {
          openingRef.current = false
          pendingRef.current = ''
          console.error('[voice] could not open speak session', err)
          onErrorRef.current?.('Could not speak that reply.')
        })
    },
    [tenantId, surface, agentId],
  )

  const duck = useCallback(() => sessionRef.current?.duck(), [])
  const unduck = useCallback(() => sessionRef.current?.unduck(), [])
  const isSpeaking = useCallback(() => sessionRef.current?.speaking ?? false, [])

  // Turning the toggle off mid-reply stops the voice at once. The reply itself
  // keeps streaming as text, because the person turned off speech, not the agent.
  useEffect(() => {
    if (!enabled) stop()
  }, [enabled, stop])

  useEffect(() => () => stop(), [stop])

  useEffect(() => {
    if (!enabled || !tenantId) return

    // The reply ended. Let what is queued play out; the session closes itself
    // and reports back through onFinished.
    //
    // The reference is deliberately KEPT until then. Dropping it here would make
    // `isSpeaking` false while the agent is audibly still talking, and barge-in
    // asks exactly that question — the interruption would go nowhere in the one
    // window where someone is most likely to interrupt.
    if (assistantText === null) {
      sessionRef.current?.end()
      spokenUpToRef.current = 0
      pendingRef.current = ''
      // The next run starts its own narration, even if it opens with the same
      // step this one did.
      lastActivityRef.current = null
      return
    }

    // A shorter text than last time means a new reply reusing the same slot.
    if (assistantText.length < spokenUpToRef.current) spokenUpToRef.current = 0

    const delta = assistantText.slice(spokenUpToRef.current)
    if (!delta) return
    spokenUpToRef.current = assistantText.length

    const session = sessionRef.current
    if (session && !session.ending) {
      speakingKindRef.current = 'reply'
      session.say(delta)
      return
    }
    // A previous reply still playing out cannot take new text — it would be
    // refused and silently dropped. The new reply supersedes it. So does a
    // progress line still finishing: the answer is what the person is waiting
    // for, and it does not queue behind "checking connected apps".
    if (session) {
      session.stop()
      sessionRef.current = null
    }

    speakingKindRef.current = 'reply'
    openAndSay(delta)
  }, [enabled, tenantId, assistantText, openAndSay])

  /**
   * Say what the team is doing, while it is doing it.
   *
   * A run that spends forty seconds in its tools is forty seconds of nothing,
   * and in a voice conversation nothing is indistinguishable from broken. This
   * gives the silence a shape.
   *
   * Deliberately timid. It speaks only when nothing else is speaking or about
   * to, never repeats itself, and leaves a gap between lines, because the
   * failure worth avoiding is not silence, it is an assistant that will not
   * stop talking.
   */
  useEffect(() => {
    if (!enabled || !tenantId || !activity) return
    if (activity === lastActivityRef.current) return
    if (sessionRef.current || openingRef.current) return
    const now = Date.now()
    if (now - lastNarratedAtRef.current < NARRATION_GAP_MS) return

    lastActivityRef.current = activity
    lastNarratedAtRef.current = now
    // Played out rather than held open, so the next line can follow it and the
    // reply is never queued behind a session kept alive for filler.
    //
    // The trailing space is not a typo. A reply that starts arriving while this
    // session is still connecting is buffered behind it and spoken in the same
    // breath, and reply text is made of token fragments that must be joined
    // exactly, so the separator has to come from the side that can afford one.
    speakingKindRef.current = 'progress'
    openAndSay(`${activity}. `, true)
  }, [enabled, tenantId, activity, openAndSay])

  const speakingKind = useCallback(
    () => (sessionRef.current?.speaking ? speakingKindRef.current : null),
    [],
  )

  return { stop, duck, unduck, isSpeaking, speakingKind }
}
