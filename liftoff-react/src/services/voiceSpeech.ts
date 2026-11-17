// Playing an agent's reply out loud, while it is still being written.
//
// The reply already streams in as text. This opens a second socket, feeds it
// that same text as it arrives, and plays the audio that comes back. Waiting for
// the whole reply before speaking would put the silence exactly where the
// listener is most aware of it — right after they finish their question.
//
// Audio arrives as raw 16-bit PCM and is scheduled back to back on a shared
// clock, so consecutive chunks join without a click or a gap. Each chunk is
// booked at the moment the previous one ends, not "now", because "now" drifts by
// however long the socket took.
//
// Barge-in has three levels, not two. `duck` turns the reply down because
// someone MIGHT be talking and is always reversible; `stop` ends it because they
// definitely were; `end` means the reply finished on its own and should play out.
// Only the middle one is triggered by a sound, which is why it must be the one
// that cannot get stuck.

import { auth } from '../config/firebase'
import type { DictationSurface } from '../hooks/useDictation'

/** Subprotocol paired with the token, matching the listening socket. */
const AUTH_PROTOCOL = 'voice'

const MSW_DISABLED =
  typeof import.meta.env.VITE_DISABLE_MSW === 'string' &&
  import.meta.env.VITE_DISABLE_MSW.toLowerCase() === 'true'

const API_BASE_URL =
  import.meta.env.DEV && !MSW_DISABLED
    ? ''
    : (import.meta.env.VITE_API_URL || 'http://localhost:8080')

/**
 * How far ahead of the clock the first chunk is booked.
 *
 * Long enough that decoding and scheduling finish before the start time
 * arrives — a chunk booked in the past is dropped, which is heard as a stutter.
 */
const SCHEDULE_LEAD_S = 0.08

/**
 * How far the reply is turned down while it is unclear whether someone is
 * talking. Quiet enough to yield the floor, loud enough that the person can tell
 * the agent is still going rather than broken.
 */
const DUCKED_GAIN = 0.12

/** Ramp, so ducking does not click. */
const GAIN_RAMP_S = 0.04

function socketUrl(params: {
  tenantId: string
  surface: DictationSurface
  agentId?: string
}): string {
  const base = API_BASE_URL || window.location.origin
  const url = new URL('/api/voice/speak', base)
  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
  url.searchParams.set('tenantId', params.tenantId)
  url.searchParams.set('surface', params.surface)
  if (params.agentId) url.searchParams.set('agentId', params.agentId)
  return url.toString()
}

export interface SpeechSessionOptions {
  tenantId: string
  surface: DictationSurface
  agentId?: string
  /** Fires when the last scheduled audio has finished playing. */
  onFinished?: () => void
  onError?: (message: string) => void
}

/** One spoken reply. Opened per turn, closed when the turn is done or interrupted. */
export class SpeechSession {
  private socket: WebSocket | null = null
  private context: AudioContext | null = null
  private sources = new Set<AudioBufferSourceNode>()
  private sampleRate = 24_000
  private nextStartTime = 0
  private closed = false
  private ending_ = false
  /**
   * The server has sent every chunk it is going to.
   *
   * Distinct from `ending_`, and the distinction is the whole bug it fixes:
   * `ending_` only means the reply TEXT finished. Synthesis of the last
   * sentences is still running, and their audio has not arrived. Finishing on
   * `ending_` cut replies off partway — whenever playback drained faster than
   * the next chunk arrived, which for a multi-sentence reply is most of them.
   */
  private serverDone = false
  /**
   * Turned down because someone might be talking.
   *
   * DUCKED, not paused. Suspending the audio clock was the first attempt and it
   * has a failure mode with no floor: suspend() and resume() are promises, so
   * two noises in quick succession race, and one lost race leaves the context
   * suspended forever — the reply never continues and nothing says why.
   *
   * A gain change cannot get stuck. The clock keeps running, the audio keeps
   * arriving, and the worst outcome of a bug here is a reply that stays quiet
   * rather than one that stops existing.
   */
  private ducked = false
  /**
   * Audio held back while ducked, in arrival order.
   *
   * Turning the volume down does not stop a reply, it only stops anyone
   * hearing it: the context clock runs on, the scheduled chunks play out, and
   * the words are spent. A second of ducking used to cost a second of the
   * answer, and if the reply happened to finish while quiet the session played
   * itself to an empty room and closed — so there was nothing left to come back
   * to, which reads as an agent that stopped mid-sentence and never resumed.
   *
   * Held rather than played. The only audio lost is whatever was already
   * scheduled into the lead, which the gain ramp fades instead of cutting.
   */
  private held: ArrayBuffer[] = []
  private gain: GainNode | null = null

  private constructor(private readonly options: SpeechSessionOptions) {}

  /** Open a session, resolving once the server has declared its audio format. */
  static async open(options: SpeechSessionOptions): Promise<SpeechSession> {
    const session = new SpeechSession(options)
    const token = await auth.currentUser?.getIdToken()
    if (!token) throw new Error('not signed in')

    const socket = new WebSocket(
      socketUrl({
        tenantId: options.tenantId,
        surface: options.surface,
        ...(options.agentId ? { agentId: options.agentId } : {}),
      }),
      [AUTH_PROTOCOL, token],
    )
    socket.binaryType = 'arraybuffer'
    session.socket = socket

    socket.onmessage = (event: MessageEvent<string | ArrayBuffer>) => {
      if (typeof event.data !== 'string') {
        session.play(event.data)
        return
      }
      let payload: { type?: string; sampleRate?: number }
      try {
        payload = JSON.parse(event.data)
      } catch {
        return
      }
      if (payload.type === 'ready' && typeof payload.sampleRate === 'number') {
        session.sampleRate = payload.sampleRate
      } else if (payload.type === 'done') {
        session.finishWhenPlayedOut()
      }
    }

    socket.onclose = (event: CloseEvent) => {
      if (!session.closed && event.code !== 1000) {
        // A reply that cannot be spoken is not worth an alarm — the text is on
        // screen either way — but it should not fail silently in the console.
        console.error('[voice] speak socket closed', event.code, event.reason)
        options.onError?.('Could not speak that reply.')
      }
      session.teardown()
    }

    socket.onerror = () => {
      console.error('[voice] speak socket error')
    }

    await new Promise<void>((resolve, reject) => {
      socket.onopen = () => resolve()
      window.setTimeout(() => reject(new Error('speak socket open timed out')), 10_000)
    })

    return session
  }

  /** Feed more of the reply. Sentence boundaries are found on the server. */
  say(text: string): void {
    if (this.closed || this.ending || !text) return
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'say', text }))
    }
  }

  /** The reply is complete. Remaining audio plays out, then the session closes. */
  end(): void {
    if (this.closed || this.ending_) return
    this.ending_ = true
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'end' }))
    }
  }

  /**
   * Barge-in. Kill the audio now, including what is already scheduled.
   *
   * Told to the server as well as acted on locally: stopping only the playback
   * would leave it synthesising, and billing for, a reply nobody can hear.
   */
  stop(): void {
    if (this.closed) return
    if (this.socket?.readyState === WebSocket.OPEN) {
      this.socket.send(JSON.stringify({ type: 'stop' }))
    }
    this.teardown()
  }

  /** Is there audio scheduled or waiting that has not been heard? */
  get speaking(): boolean {
    return this.sources.size > 0 || this.held.length > 0
  }

  /**
   * Stop the sound without giving up on it.
   *
   * Used the moment someone might be speaking, before anyone knows whether they
   * are. Cheap and reversible, unlike `stop`, which ends the reply and cannot be
   * taken back — the wrong response to a cough.
   */
  duck(): void {
    if (this.closed || this.ducked) return
    this.ducked = true
    this.applyGain(DUCKED_GAIN)
  }

  /** It was nothing. Back up to full, and carry on where the reply left off. */
  unduck(): void {
    if (this.closed || !this.ducked) return
    this.ducked = false
    this.applyGain(1)

    // The clock ran on while nobody was listening, so the queue restarts from
    // now rather than from where the last chunk would have ended. Without this
    // every held chunk is scheduled in the past and plays at once.
    this.nextStartTime = 0
    const held = this.held
    this.held = []
    for (const pcm of held) this.schedule(pcm)
  }

  /** Ramped rather than stepped, because an instant gain change clicks. */
  private applyGain(value: number): void {
    const gain = this.gain
    const context = this.context
    if (!gain || !context) return
    gain.gain.cancelScheduledValues(context.currentTime)
    gain.gain.setTargetAtTime(value, context.currentTime, GAIN_RAMP_S)
  }

  /**
   * Has this session been told the reply is over?
   *
   * It may still be speaking — `end` starts a play-out, it does not stop one.
   * A caller with more text to say needs a new session rather than this one,
   * which will refuse it.
   */
  get ending(): boolean {
    return this.ending_
  }

  /** Take one PCM chunk: play it, or hold it if nobody can hear right now. */
  private play(pcm: ArrayBuffer): void {
    if (this.closed || pcm.byteLength < 2) return
    if (this.ducked) {
      this.held.push(pcm)
      return
    }
    this.schedule(pcm)
  }

  /** Schedule one PCM chunk immediately after whatever is already queued. */
  private schedule(pcm: ArrayBuffer): void {
    if (this.closed) return

    if (!this.context) {
      this.context = new AudioContext()
      this.nextStartTime = 0
    }
    const context = this.context
    // Resumes a context the browser suspended before the page was interacted
    // with; without it the audio is scheduled and silently never heard.
    if (context.state === 'suspended') void context.resume().catch(() => {})

    if (!this.gain) {
      this.gain = context.createGain()
      this.gain.gain.value = this.ducked ? DUCKED_GAIN : 1
      this.gain.connect(context.destination)
    }

    const samples = new Int16Array(pcm, 0, Math.floor(pcm.byteLength / 2))
    // The buffer declares the SERVER's rate; the graph resamples to the output
    // device. Creating the context at that rate instead fails on devices that
    // will not run at it.
    const buffer = context.createBuffer(1, samples.length, this.sampleRate)
    const channel = buffer.getChannelData(0)
    for (let i = 0; i < samples.length; i++) {
      channel[i] = (samples[i] as number) / 0x8000
    }

    const source = context.createBufferSource()
    source.buffer = buffer
    source.connect(this.gain)

    const startAt = Math.max(context.currentTime + SCHEDULE_LEAD_S, this.nextStartTime)
    source.start(startAt)
    this.nextStartTime = startAt + buffer.duration

    this.sources.add(source)
    source.onended = () => {
      this.sources.delete(source)
      // Held audio is unheard audio. Finishing on an empty scheduler while a
      // queue is waiting is exactly how a ducked reply used to disappear.
      if (this.serverDone && this.sources.size === 0 && this.held.length === 0) this.finish()
    }
  }

  /** Server says everything is sent; finish once the speakers agree. */
  private finishWhenPlayedOut(): void {
    this.serverDone = true
    if (this.sources.size === 0 && this.held.length === 0) this.finish()
  }

  private finish(): void {
    if (this.closed) return
    this.options.onFinished?.()
    this.teardown()
  }

  private teardown(): void {
    if (this.closed) return
    this.closed = true

    for (const source of this.sources) {
      try {
        source.onended = null
        source.stop()
      } catch {
        // Already finished. Nothing to stop.
      }
    }
    this.sources.clear()
    this.held = []

    void this.context?.close().catch(() => {})
    this.context = null

    const socket = this.socket
    this.socket = null
    if (socket) {
      socket.onclose = null
      socket.onmessage = null
      socket.onerror = null
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, 'done')
      }
    }
  }
}
