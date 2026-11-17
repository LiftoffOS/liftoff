// Dictation: press, speak, watch the words land.
//
// Audio streams up while it is being spoken and transcripts stream back, so the
// composer fills in as you talk. The first version of this uploaded the whole
// recording and waited, which showed nothing at all and then everything at once
// — the delay was the feature people noticed.
//
// Two kinds of text come back. An INTERIM is Cloud Speech's best guess so far
// and is replaced by the next one; a FINAL settles a segment and is kept. The
// composer therefore renders committed text plus whatever the current interim
// is, and only committed text survives the session.
//
// Raw PCM is what goes up, not a container. MediaRecorder cannot help here:
// only the first chunk of a WebM stream carries the headers a decoder needs, so
// chunk two onwards is undecodable on its own. An AudioWorklet gives us the
// samples directly.
//
// Stopping is a half-close. The recogniser usually settles the last segment only
// once it knows no more audio is coming, so pressing stop sends a `stop` frame
// and keeps the socket open; the server drains the final text and closes. Hanging
// up at that moment would discard the words just spoken.
//
// Guards live in refs rather than state on purpose. They protect behaviour and
// must not re-render the button, whose appearance is owned by the surface.

import { useCallback, useEffect, useRef, useState } from 'react'
import { auth } from '../config/firebase'

export type DictationSurface = 'agent_chat' | 'team_plan' | 'insights' | 'liftoff'

/** Subprotocol paired with the token, so the two are unambiguous to the server. */
const AUTH_PROTOCOL = 'voice'

/** Stop listening after this much silence, matching the server's own idle timer. */
const IDLE_TIMEOUT_MS = 30_000

/**
 * Reconnect budget for a conversation whose socket drops.
 *
 * Bounded so a server that refuses every connection is not retried forever, and
 * delayed so a reconnect loop cannot become a busy loop.
 */
/**
 * Shortest interim transcript treated as someone starting to speak.
 *
 * Noise usually recognises as one or two stray characters; a person interrupting
 * produces a word.
 */
const MIN_SPEECH_CHARS = 3

/**
 * Silence after the last recognised TRANSCRIPT that ends a spoken turn.
 *
 * The last resort, used only when no loudness readings ever arrive from the
 * capture worklet. It has to be this long because it measures the wrong thing:
 * transcripts arrive when the network delivers them, not when the speaker
 * stopped, so anything shorter would cut people off on a slow connection. When
 * the worklet is reporting, `TURN_SILENCE_MS` below does the job properly.
 */
const UTTERANCE_SETTLE_MS = 1200

/**
 * How far above the noise floor counts as somebody talking.
 *
 * Multiplicative rather than absolute because the floor moves: automatic gain
 * control lifts room tone during pauses, so a fixed threshold reads an empty
 * room as speech within a minute of arming the microphone.
 */
const SPEECH_FACTOR = 2.2

/**
 * The quietest sound that may be called speech, whatever the floor says.
 *
 * Without it, a silent room drives the floor towards zero and any multiple of
 * zero is still zero, so the faintest sample in the buffer becomes an utterance.
 */
const MIN_SPEECH_RMS = 0.008

/**
  * Time above the threshold before a sound is treated as someone speaking.
  *
  * The single most effective filter against a room full of objects, because
  * almost nothing that is not a voice makes a sustained noise. A key press, a
  * trackpad tap, a mug on a desk: all of them are over long before this.
  */
const SPEECH_ONSET_MS = 200

/**
 * The tallest peak a reading may carry, relative to its average, and still be
 * allowed to START an utterance.
 *
 * A collision is nearly all peak: a key bottoming out puts a spike into an
 * otherwise quiet stretch of audio, so its loudest sample towers over its
 * average. A voice is a sustained pressure wave and sits far below this, even
 * on a hard consonant. Applied only to starting speech, never to continuing
 * it, because somebody typing while they talk should not cut their own
 * sentence in half.
 */
const MAX_ONSET_CREST = 6

/**
 * Silence that ends a spoken turn, measured in audio rather than in messages.
 *
 * Shorter than the transcript-based fallback by design: this one starts
 * counting at the acoustic moment the person stopped, which is where every
 * other voice stack measures from too.
 */
const TURN_SILENCE_MS = 700

/**
 * After the room goes quiet, how long the recogniser gets to catch up.
 *
 * The microphone knows the turn is over before the transcript for its last
 * words has crossed the network. Ending the turn on silence alone is what
 * turns a shorter window into truncated sentences, so the turn waits for the
 * words to stop arriving as well.
 */
const TRANSCRIPT_CATCHUP_MS = 250

/** A cap on that wait, for words that are never coming. */
const TRANSCRIPT_CATCHUP_CAP_MS = 1500

/**
 * The shortest utterance the recogniser may turn into a turn ON ITS OWN, with
 * no agreement from the microphone that anybody was talking.
 *
 * A recogniser handed a noisy room returns words. Not garbage that looks like
 * noise — ordinary short words, "uh" and "the" and "okay", indistinguishable
 * from someone speaking except that nobody was. Before this, one of them ended
 * a reply, aborted the run behind it, and was sent as a turn.
 *
 * It costs something real: a person quiet enough that the microphone never
 * registers them, saying only "stop", is not heard. That is the right way round
 * — they say it again slightly louder and the room agrees — and it applies only
 * when the room did NOT agree. A corroborated turn is sent at any length,
 * because "no" and "wait" are how people actually interrupt.
 */
const MIN_UNCORROBORATED_CHARS = 8

/**
 * How long a sound may be treated as speech while producing no words at all.
 *
 * Loudness alone cannot tell a person from a fan, and a fan never stops, so a
 * room like that would otherwise sit inside one endless utterance: the reply
 * held down, the turn never ending, nothing to show for it. The recogniser is
 * the only thing here that actually knows what speech is, so after this long
 * with nothing from it, the sound is taken for noise and the floor is moved up
 * to where that noise lives.
 */
const NOISE_PATIENCE_MS = 4000

/**
 * How fast the noise floor follows the room, per reading.
 *
 * Down quickly and up slowly, so the floor settles into the quietest recent
 * moment rather than being dragged up by whoever is talking.
 */
const FLOOR_FALL = 0.3
const FLOOR_RISE = 0.005

/**
 * How fast the floor follows a room that is loud without anybody in it.
 *
 * Slow enough that a person talking for half a minute never drags it up, since
 * speech has gaps and the gaps pull it back down. Its job is the room that has
 * no gaps: a fan, a television, a road outside. Without it a steady noise above
 * the absolute minimum is heard as one endless sentence.
 */
const FLOOR_CREEP = 0.0005

/**
 * The span the level meter covers, in decibels.
 *
 * Loudness is logarithmic and a ring drawn from raw amplitude is not a meter:
 * ordinary speech sits so far above the threshold that every syllable pegs it,
 * which is how you end up back at a light that is either on or off. Between
 * about -50 and -14 dBFS is quiet-room to talking-clearly.
 */
const METER_FLOOR_DB = -50
const METER_TOP_DB = -14

function meterLevel(rms: number): number {
  const db = 20 * Math.log10(Math.max(rms, 1e-6))
  return Math.min(1, Math.max(0, (db - METER_FLOOR_DB) / (METER_TOP_DB - METER_FLOOR_DB)))
}

const MAX_RECONNECTS = 5
const RECONNECT_DELAY_MS = 600

const MSW_DISABLED =
  typeof import.meta.env.VITE_DISABLE_MSW === 'string' &&
  import.meta.env.VITE_DISABLE_MSW.toLowerCase() === 'true'

const API_BASE_URL =
  import.meta.env.DEV && !MSW_DISABLED
    ? ''
    : (import.meta.env.VITE_API_URL || 'http://localhost:8080')

/**
 * The capture worklet, served as a same-origin file.
 *
 * Not a blob: URL, which is what this was first. An AudioWorklet module is a
 * script, the site's Content-Security-Policy allows scripts from 'self' only,
 * and a blob is refused before it loads — taking the microphone with it. Serving
 * it properly satisfies the policy instead of weakening it.
 */
const WORKLET_URL = '/pcm-forwarder.worklet.js'

/**
 * What the microphone is being used for.
 *
 * `dictation` fills the composer and the person decides when they are done.
 * `conversation` sends each utterance as soon as they stop talking, and keeps
 * listening afterwards. The capture is identical; only who ends the utterance
 * differs.
 */
export type ListenMode = 'dictation' | 'conversation'

/** A loudness reading from the capture worklet, and the audio time it covers. */
interface WorkletLevel {
  type: 'level'
  rms: number
  /** Loudest single sample in the span. Absent from older readings. */
  peak?: number
  ms: number
}

function socketUrl(params: {
  tenantId: string
  surface: DictationSurface
  agentId?: string
  mode: ListenMode
  sampleRate: number
}): string {
  const base = API_BASE_URL || window.location.origin
  const url = new URL('/api/voice/listen', base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('tenantId', params.tenantId)
  url.searchParams.set('surface', params.surface)
  if (params.agentId) url.searchParams.set('agentId', params.agentId)
  if (params.mode === 'conversation') url.searchParams.set('mode', 'conversation')
  // The rate the worklet is ACTUALLY forwarding at.
  //
  // An AudioContext runs at whatever the output device negotiated, and the
  // worklet hands over its samples without resampling them — so this is a
  // property of the hardware, not a choice. The server used to assume 48000,
  // which is right on most desktops, wrong on the 44.1 kHz ones, and badly wrong
  // on a Bluetooth headset in hands-free mode: its 16 kHz was read as three
  // times too fast and came back as an empty transcript, on exactly the device
  // someone puts on to hold a conversation.
  url.searchParams.set('sampleRate', String(Math.round(params.sampleRate)))
  return url.toString()
}

export interface UseDictationOptions {
  tenantId: string | undefined
  /** Which chat this is. Decides who pays, so it is declared rather than
   *  inferred from whether an agentId is present. */
  surface: DictationSurface
  /** `internal_agents.id` for the thread. */
  agentId?: string
  /** The composer's current text. Read once when a session starts, so dictation
   *  appends to whatever was already typed instead of replacing it. */
  getComposerText: () => string
  /** Write the composer. Called on every interim, so it must be cheap. */
  setComposerText: (text: string) => void
  onError: (message: string) => void
  /** Dictation unless told otherwise, so existing callers are unaffected. */
  mode?: ListenMode
  /**
   * Conversation only: a complete utterance, fired when the speaker stops.
   *
   * The socket stays open afterwards — the person is still in the conversation,
   * they have just finished a sentence.
   *
   * `corroborated` is whether the MICROPHONE agreed a voice was there, as
   * opposed to the recogniser having produced words on its own. The two
   * authorities answer different questions — the room knows whether somebody
   * spoke, the recogniser knows what they said — and an interruption worth
   * ending a reply for needs both.
   */
  onUtterance?: (text: string, corroborated: boolean) => void
  /**
   * Conversation only: the person has started speaking again.
   *
   * Fires on the first word of any utterance, which is what makes it usable as
   * a barge-in trigger while a reply is playing.
   */
  onSpeechStart?: () => void
  /**
   * Conversation only: what sounded like speech came to nothing.
   *
   * A cough, a door, a chair. The recogniser reported activity, produced no
   * settled words, and gave up. Whatever was held back on `onSpeechStart` can be
   * released.
   */
  onSpeechDiscarded?: () => void
}

export interface UseDictationResult {
  isListening: boolean
  toggle: () => Promise<void>
  /** Arm the microphone. Idempotent. */
  start: () => Promise<void>
  /** Disarm it, draining any settled text first. Idempotent. */
  stop: () => void
  /**
   * How loud the person is right now, 0 to 1, for anything that wants to show
   * it.
   *
   * A ref rather than state on purpose. This changes about fifty times a
   * second, and putting that through React would re-render the entire chat at
   * audio rate to move one ring by two pixels. Whoever displays it reads this
   * from an animation frame.
   */
  levelRef: React.RefObject<number>
}

export function useDictation({
  tenantId,
  surface,
  agentId,
  getComposerText,
  setComposerText,
  onError,
  mode = 'dictation',
  onUtterance,
  onSpeechStart,
  onSpeechDiscarded,
}: UseDictationOptions): UseDictationResult {
  const [isListening, setIsListening] = useState(false)

  const socketRef = useRef<WebSocket | null>(null)
  const contextRef = useRef<AudioContext | null>(null)
  const streamRef = useRef<MediaStream | null>(null)
  const idleTimerRef = useRef<number | null>(null)
  /** Guards the permission prompt against a double press. */
  const startPendingRef = useRef(false)
  /** Set once stop is sent, while the last transcript is still being drained. */
  const stoppingRef = useRef(false)
  /** Backstop in case the server never closes after a stop. */
  const drainTimerRef = useRef<number | null>(null)
  /** Segments already settled this session, joined into the committed text. */
  const committedRef = useRef<string[]>([])
  /** Whatever was in the composer when this session started. Dictation appends
   *  to it rather than replacing what someone had already typed. */
  const baseRef = useRef('')

  /** Conversation: is somebody currently mid-utterance? */
  const speakingRef = useRef(false)
  /** Conversation: fires the turn when the recogniser goes quiet. */
  const settleTimerRef = useRef<number | null>(null)

  /** Loudness, published for whoever draws it. */
  const levelRef = useRef(0)
  /** The room's own noise, tracked so speech can be measured against it. */
  const floorRef = useRef(MIN_SPEECH_RMS)
  /** Audio time spent above and below the speech threshold, in milliseconds. */
  const aboveMsRef = useRef(0)
  const belowMsRef = useRef(0)
  /** Has the worklet ever reported a level? Decides which turn-end path runs. */
  const vadSeenRef = useRef(false)
  /** Audio time this utterance has lasted, and whether it has produced a word. */
  const utteranceMsRef = useRef(0)
  const heardWordsRef = useRef(false)
  /** The room has gone quiet and the turn is waiting on the recogniser. */
  const turnEndPendingRef = useRef(false)
  const catchupTimerRef = useRef<number | null>(null)
  const catchupCapTimerRef = useRef<number | null>(null)
  /** Reconnect attempts since the last deliberate start. */
  const reconnectsRef = useRef(0)
  const reconnectTimerRef = useRef<number | null>(null)
  const startRef = useRef<(() => Promise<void>) | null>(null)

  const getComposerTextRef = useRef(getComposerText)
  const setComposerTextRef = useRef(setComposerText)
  const onErrorRef = useRef(onError)
  const onUtteranceRef = useRef(onUtterance)
  const onSpeechStartRef = useRef(onSpeechStart)
  const onSpeechDiscardedRef = useRef(onSpeechDiscarded)
  // Kept current in an effect rather than during render. Every one of these is
  // read from a socket handler or a timer that outlives the render which made
  // it, so they are only ever consulted after commit and the effect is early
  // enough. Writing a ref during render is the thing this pattern must not do.
  useEffect(() => {
    getComposerTextRef.current = getComposerText
    setComposerTextRef.current = setComposerText
    onErrorRef.current = onError
    onUtteranceRef.current = onUtterance
    onSpeechStartRef.current = onSpeechStart
    onSpeechDiscardedRef.current = onSpeechDiscarded
  })

  /** Paint the composer: what was there, plus what has settled, plus the guess
   *  currently in flight. */
  const paint = useCallback((interim: string) => {
    const parts = [baseRef.current, ...committedRef.current, interim]
      .map((part) => part.trim())
      .filter(Boolean)
    setComposerTextRef.current(parts.join(' '))
  }, [])

  /** Stop waiting for the turn to end, whether it ended or the speaker resumed. */
  const clearTurnEndWait = useCallback(() => {
    turnEndPendingRef.current = false
    if (catchupTimerRef.current !== null) {
      window.clearTimeout(catchupTimerRef.current)
      catchupTimerRef.current = null
    }
    if (catchupCapTimerRef.current !== null) {
      window.clearTimeout(catchupCapTimerRef.current)
      catchupCapTimerRef.current = null
    }
  }, [])

  /**
   * The spoken turn is over: send what was said, or release the reply if it
   * turned out to be nothing.
   *
   * Reached from the recogniser's end-of-speech event, from the room going
   * quiet, and from the settle timer, whichever comes first, so no single
   * missing signal can strand a turn.
   */
  const completeUtterance = useCallback(() => {
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current)
      settleTimerRef.current = null
    }
    clearTurnEndWait()
    aboveMsRef.current = 0
    belowMsRef.current = 0
    utteranceMsRef.current = 0
    heardWordsRef.current = false
    const utterance = committedRef.current.join(' ').trim()
    const wasTentative = speakingRef.current
    committedRef.current = []
    speakingRef.current = false

    // Silence is not a turn. Nothing was said, so nothing is sent and the
    // microphone stays open — but anything held back on the strength of that
    // noise has to be released, or the agent stays quiet forever.
    if (!utterance) {
      paint('')
      if (wasTentative) onSpeechDiscardedRef.current?.()
      return
    }
    // Words the room never backed up, and too few of them to be anything but
    // the recogniser talking to itself. Dropped rather than sent: a turn made
    // of a noise costs money, answers nobody, and reads as the team replying to
    // something that was never said.
    if (!wasTentative && utterance.length < MIN_UNCORROBORATED_CHARS) {
      baseRef.current = ''
      paint('')
      return
    }

    baseRef.current = ''
    paint('')
    onUtteranceRef.current?.(utterance, wasTentative)
  }, [paint, clearTurnEndWait])

  const armSettleTimer = useCallback(() => {
    if (settleTimerRef.current !== null) window.clearTimeout(settleTimerRef.current)
    settleTimerRef.current = window.setTimeout(() => {
      settleTimerRef.current = null
      completeUtterance()
    }, UTTERANCE_SETTLE_MS)
  }, [completeUtterance])

  /**
   * Wait for the recogniser to catch up with the microphone, then end the turn.
   *
   * Restarted by every transcript that arrives, so the turn ends once the words
   * stop coming rather than at a fixed moment after the room went quiet. The cap
   * is what stops a recogniser that has nothing more to say from holding the
   * turn open indefinitely.
   */
  const armCatchupTimer = useCallback(() => {
    if (catchupTimerRef.current !== null) window.clearTimeout(catchupTimerRef.current)
    catchupTimerRef.current = window.setTimeout(() => {
      catchupTimerRef.current = null
      completeUtterance()
    }, TRANSCRIPT_CATCHUP_MS)
  }, [completeUtterance])

  const beginTurnEnd = useCallback(() => {
    if (turnEndPendingRef.current) return
    turnEndPendingRef.current = true
    armCatchupTimer()
    catchupCapTimerRef.current = window.setTimeout(() => {
      catchupCapTimerRef.current = null
      completeUtterance()
    }, TRANSCRIPT_CATCHUP_CAP_MS)
  }, [armCatchupTimer, completeUtterance])

  /**
   * One loudness reading from the capture worklet.
   *
   * This is the whole voice-activity detector: a floor that follows the room, a
   * threshold above it, and two counters. It lives here rather than in the
   * worklet so that every decision it makes can be driven by a test with
   * synthetic readings.
   */
  const handleLevel = useCallback(
    (rms: number, ms: number, peak?: number) => {
      vadSeenRef.current = true
      const threshold = Math.max(floorRef.current * SPEECH_FACTOR, MIN_SPEECH_RMS)
      const loud = rms >= threshold

      // Published for the microphone button. Nothing at all below the speech
      // threshold, so a ring means it is hearing somebody rather than that a
      // room exists; above it, how loud they are.
      levelRef.current = loud ? meterLevel(rms) : 0
      // The floor learns mostly from quiet, or it climbs to meet whoever is
      // talking and stops being able to hear them. It still creeps upward
      // through sustained noise, which is the only way out of a room that is
      // loud with nobody in it.
      const pull = loud ? FLOOR_CREEP : rms < floorRef.current ? FLOOR_FALL : FLOOR_RISE
      floorRef.current += (rms - floorRef.current) * pull

      // Dictation shows the level and nothing else: the person decides when
      // they are done, so nothing here may end anything.
      if (mode !== 'conversation') return

      if (loud) {
        belowMsRef.current = 0

        // A bang, not a voice. Loud for an instant and quiet either side of it,
        // which is every key press, trackpad tap and knock on the desk. It may
        // not start an utterance, and it resets whatever was accumulating, so a
        // burst of typing never adds up to somebody talking.
        //
        // Only while starting. Once a voice is established these readings are
        // let through, because a person who types while they speak must not cut
        // their own sentence in half.
        if (!speakingRef.current && peak !== undefined && peak > rms * MAX_ONSET_CREST) {
          aboveMsRef.current = 0
          return
        }

        aboveMsRef.current += ms
        if (aboveMsRef.current < SPEECH_ONSET_MS) return
        // Still going after all. Whatever silence started to end this turn was
        // a pause for breath.
        if (turnEndPendingRef.current) clearTurnEndWait()
        if (!speakingRef.current) {
          speakingRef.current = true
          utteranceMsRef.current = 0
          heardWordsRef.current = false
          onSpeechStartRef.current?.()
          return
        }

        utteranceMsRef.current += ms
        if (heardWordsRef.current || utteranceMsRef.current < NOISE_PATIENCE_MS) return

        // Long enough, and not one word. It was a room, not a person. Take the
        // floor up to where the sound is so the same noise is not heard as
        // speech a second later, and let go of the reply it was holding down.
        floorRef.current = rms
        speakingRef.current = false
        aboveMsRef.current = 0
        utteranceMsRef.current = 0
        onSpeechDiscardedRef.current?.()
        return
      }

      aboveMsRef.current = 0
      if (!speakingRef.current) return
      belowMsRef.current += ms
      if (belowMsRef.current >= TURN_SILENCE_MS) beginTurnEnd()
    },
    [mode, beginTurnEnd, clearTurnEndWait],
  )

  // Reached through a ref because the port handler is built inside `start` and
  // outlives the render that made it.
  const handleLevelRef = useRef(handleLevel)
  useEffect(() => { handleLevelRef.current = handleLevel })

  const teardown = useCallback(() => {
    if (idleTimerRef.current !== null) {
      window.clearTimeout(idleTimerRef.current)
      idleTimerRef.current = null
    }
    if (drainTimerRef.current !== null) {
      window.clearTimeout(drainTimerRef.current)
      drainTimerRef.current = null
    }
    if (reconnectTimerRef.current !== null) {
      window.clearTimeout(reconnectTimerRef.current)
      reconnectTimerRef.current = null
    }
    if (settleTimerRef.current !== null) {
      window.clearTimeout(settleTimerRef.current)
      settleTimerRef.current = null
    }
    clearTurnEndWait()
    stoppingRef.current = false
    speakingRef.current = false
    // The room this session learned is not the room the next one starts in,
    // and a ring left glowing on a disarmed microphone is a lie.
    levelRef.current = 0
    floorRef.current = MIN_SPEECH_RMS
    aboveMsRef.current = 0
    belowMsRef.current = 0
    utteranceMsRef.current = 0
    heardWordsRef.current = false
    vadSeenRef.current = false
    // Detach before closing. Closing fires onclose, whose handler tears down —
    // and without this the two call each other until the stack gives out.
    const socket = socketRef.current
    socketRef.current = null
    if (socket) {
      socket.onclose = null
      socket.onmessage = null
      socket.onerror = null
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, 'done')
      }
    }
    void contextRef.current?.close().catch(() => {})
    contextRef.current = null
    streamRef.current?.getTracks().forEach((track) => track.stop())
    streamRef.current = null
  }, [clearTurnEndWait])

  useEffect(() => () => teardown(), [teardown])

  const armIdleTimer = useCallback(() => {
    if (idleTimerRef.current !== null) window.clearTimeout(idleTimerRef.current)
    idleTimerRef.current = window.setTimeout(() => {
      teardown()
      setIsListening(false)
    }, IDLE_TIMEOUT_MS)
  }, [teardown])

  const start = useCallback(async () => {
    if (startPendingRef.current) return

    if (!navigator.mediaDevices?.getUserMedia || typeof AudioWorkletNode === 'undefined') {
      onErrorRef.current('Your browser does not support microphone access.')
      return
    }
    if (!tenantId) return

    // Whatever came before is done with, and none of it may be left running.
    //
    // A half-closed predecessor is the case that matters: voice mode restarts an
    // already-armed microphone, because the mode travels in the socket URL and
    // an open session is listening under the old rules. That predecessor leaves
    // three things behind. A drain timer, which calls teardown and would
    // dismantle the session being started here five seconds after it began
    // working. A live microphone and audio graph, which nothing else will ever
    // close. And `stoppingRef`, which gates the audio upload — left set, the new
    // session opens, shows itself as listening, and sends not one sample, so the
    // conversation hears nothing and says nothing until the idle timer gives up.
    //
    // Draining the predecessor's last words is worth less than any of that.
    teardown()

    startPendingRef.current = true
    try {
      // Only the permission request sits in this try. Anything wider and a
      // failure further along reports itself as a denied microphone, sending
      // the person to fix a permission they already granted.
      let stream: MediaStream
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          // Echo cancellation matters most in conversation, where the agent's
          // own voice is coming out of the speakers into this microphone:
          // without it the reply is transcribed as the person interrupting
          // themselves, and the conversation talks over itself in a loop.
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
        })
      } catch (err) {
        console.error('[dictation] getUserMedia failed', err)
        onErrorRef.current(
          'Microphone access is blocked. Allow microphone access in your browser settings to dictate.',
        )
        return
      }
      streamRef.current = stream

      const token = await auth.currentUser?.getIdToken()
      if (!token) {
        teardown()
        onErrorRef.current('Could not transcribe that. Please try again.')
        return
      }

      const context = new AudioContext()
      contextRef.current = context
      await context.audioWorklet.addModule(WORKLET_URL)

      // The token rides as a subprotocol, not a query parameter: query strings
      // land in access logs and a bearer token has no business being there.
      const socket = new WebSocket(
        // Opened after the AudioContext on purpose: its rate is what the server
        // has to decode against, and it is not known until the device grants it.
        socketUrl({
          tenantId,
          surface,
          mode,
          sampleRate: context.sampleRate,
          ...(agentId ? { agentId } : {}),
        }),
        [AUTH_PROTOCOL, token],
      )
      socket.binaryType = 'arraybuffer'
      socketRef.current = socket

      committedRef.current = []
      baseRef.current = getComposerTextRef.current()

      socket.onmessage = (event: MessageEvent<string>) => {
        armIdleTimer()
        let payload: { type?: string; transcript?: string }
        try {
          payload = JSON.parse(event.data)
        } catch {
          return
        }

        // The speaker stopped, as judged by the recogniser rather than by a
        // timer here. In conversation that ends the utterance and sends it.
        if (payload.type === 'speech_end') {
          if (mode !== 'conversation') return
          completeUtterance()
          return
        }

        if (!payload.transcript) return

        // The recogniser has confirmed this was speech, which is what stops the
        // patience timer from writing the sound off as a noisy room.
        heardWordsRef.current = true

        // Words are still arriving, so the recogniser has not caught up with a
        // microphone that already went quiet. Give it another window before the
        // turn closes, or the tail of the sentence is dropped.
        if (turnEndPendingRef.current) armCatchupTimer()

        // Someone may have started talking. Deliberately provisional: the
        // recogniser emits interim text for coughs, doors and passing chatter,
        // and treating the first of those as an interruption is what let a noise
        // kill a reply outright.
        //
        // A couple of characters is the cheapest filter that removes the
        // shortest garbage without delaying a real interruption.
        //
        // ONLY when there are no levels to go on. The comment here used to say
        // that and the code did not, which is why a reply ducked at every
        // keystroke: the recogniser hallucinates a few characters out of
        // keyboard noise, and three characters was the entire test. When the
        // worklet is reporting, the room decides who is talking, and it will
        // not mistake a bang for a voice.
        if (
          mode === 'conversation'
          && !vadSeenRef.current
          && !speakingRef.current
          && (payload.transcript?.trim().length ?? 0) >= MIN_SPEECH_CHARS
        ) {
          speakingRef.current = true
          onSpeechStartRef.current?.()
        }

        if (payload.type === 'final') {
          committedRef.current.push(payload.transcript)
          // Settled text stays; the interim that preceded it is superseded.
          paint('')
        } else if (payload.type === 'interim') {
          paint(payload.transcript)
        }

        // Anything recognised means they are still going. The turn ends when
        // this stops being rearmed — or sooner, if the recogniser says so.
        //
        // Only when the room is not already driving this turn. With levels
        // arriving AND a voice established, silence is measured in audio where
        // it happens, and rearming a transcript timer alongside it would let a
        // slow network hold a finished turn open.
        //
        // The other case matters more than it looks: somebody quiet enough that
        // the detector never called it speech, whose words the recogniser heard
        // anyway. Without this their turn has nothing to end it at all.
        if (mode === 'conversation' && (!vadSeenRef.current || !speakingRef.current)) {
          armSettleTimer()
        }
      }

      socket.onerror = () => {
        console.error('[dictation] socket error')
      }

      socket.onclose = (event: CloseEvent) => {
        // A socket that has already been superseded — voice mode restarting the
        // session under conversation rules, say — must not tear down the one
        // that replaced it. Same guard as the server uses when it rotates its
        // upstream, and for the same reason.
        if (socketRef.current !== socket) return
        // 1000 is a normal finish, including our own teardown.
        if (event.code !== 1000) {
          console.error('[dictation] socket closed', event.code, event.reason)
          // In a conversation, a dropped socket is not the end of the
          // conversation — the person is still sitting there talking. Reconnect
          // instead of disarming the microphone and making them press a button
          // they never pressed to begin with. Dictation keeps the old
          // behaviour: it is one utterance, and starting over is the person's
          // call.
          if (mode === 'conversation' && !stoppingRef.current && reconnectsRef.current < MAX_RECONNECTS) {
            reconnectsRef.current += 1
            teardown()
            reconnectTimerRef.current = window.setTimeout(() => {
              startRef.current?.()
            }, RECONNECT_DELAY_MS)
            return
          }
          onErrorRef.current('Could not transcribe that. Please try again.')
        }
        teardown()
        setIsListening(false)
      }

      await new Promise<void>((resolve, reject) => {
        socket.onopen = () => resolve()
        window.setTimeout(() => reject(new Error('socket open timed out')), 10_000)
      })

      const source = context.createMediaStreamSource(stream)
      const node = new AudioWorkletNode(context, 'pcm-forwarder')
      node.port.onmessage = (event: MessageEvent<ArrayBuffer | WorkletLevel>) => {
        // Two kinds of message share this port, told apart by what they are
        // rather than by a wrapper: audio stays a bare buffer so it can keep
        // being transferred rather than copied, which is the whole reason the
        // capture path is cheap.
        if (!(event.data instanceof ArrayBuffer)) {
          handleLevelRef.current(event.data.rms, event.data.ms, event.data.peak)
          return
        }
        // Once stop is sent, the upstream is finishing: more audio would be
        // rejected and could reopen a segment that is already settling.
        if (!stoppingRef.current && socket.readyState === WebSocket.OPEN) {
          socket.send(event.data)
        }
      }
      source.connect(node)
      // Terminate the graph without audible output; a worklet with no
      // destination is not pulled by the render quantum in every engine.
      const sink = context.createGain()
      sink.gain.value = 0
      node.connect(sink).connect(context.destination)

      armIdleTimer()
      setIsListening(true)
    } catch (err) {
      console.error('[dictation] could not start streaming', err)
      teardown()
      onErrorRef.current('Could not transcribe that. Please try again.')
    } finally {
      startPendingRef.current = false
    }
  }, [tenantId, surface, agentId, mode, teardown, armIdleTimer, paint, armCatchupTimer, armSettleTimer, completeUtterance])

  // The close handler restarts a dropped conversation, and it is defined inside
  // `start` — so it reaches the current `start` through a ref rather than
  // capturing the one that existed when the socket was opened.
  useEffect(() => { startRef.current = start })

  const stop = useCallback(() => {
    // Deliberate stop: no reconnect, and the budget resets for next time.
    reconnectsRef.current = 0
    const socket = socketRef.current
    if (socket && socket.readyState === WebSocket.OPEN) {
      // Half-close: stop sending audio, but stay open for the settled text.
      stoppingRef.current = true
      socket.send(JSON.stringify({ type: 'stop' }))
      // The server closes once it has drained. If it never does, do not leave
      // the microphone live.
      drainTimerRef.current = window.setTimeout(() => teardown(), 5000)
    } else {
      teardown()
    }
    setIsListening(false)
  }, [teardown])

  const toggle = useCallback(async () => {
    if (startPendingRef.current) return
    if (isListening) {
      stop()
      return
    }
    reconnectsRef.current = 0
    await start()
  }, [isListening, start, stop])

  return { isListening, toggle, start, stop, levelRef }
}
