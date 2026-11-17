import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { useDictation } from './useDictation'

// The seam between the microphone and the composer. Everything here is a
// property someone would notice immediately if it broke: words appearing while
// you speak, a guess being replaced rather than repeated, and text you had
// already typed surviving.

vi.mock('../config/firebase', () => ({
  auth: { currentUser: { getIdToken: () => Promise.resolve('test-token') } },
}))

/** What the device is capturing at, as a real AudioContext would report. */
let capturedSampleRate = 48000

class FakeWebSocket {
  static OPEN = 1
  static CONNECTING = 0
  static instances: FakeWebSocket[] = []

  readyState = 1
  binaryType = ''
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onmessage: ((event: { data: string }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((event: { code: number; reason: string }) => void) | null = null

  constructor(
    public url: string,
    public protocols?: string[],
  ) {
    FakeWebSocket.instances.push(this)
    // Open on the next tick, as a real socket would.
    setTimeout(() => this.onopen?.(), 0)
  }

  send(data: unknown): void {
    this.sent.push(data)
  }

  close(code = 1000, reason = ''): void {
    // A real socket fires onclose once; firing again on an already-closed
    // socket would be a fiction the hook never has to survive.
    if (this.readyState === 3) return
    this.readyState = 3
    this.onclose?.({ code, reason })
  }

  /** Push a server frame. */
  emit(payload: unknown): void {
    this.onmessage?.({ data: JSON.stringify(payload) })
  }
}

type WorkletMessage = ArrayBuffer | { type: 'level'; rms: number; peak?: number; ms: number }

/** The capture nodes built so far, so a test can post audio the way one does. */
const worklets: { port: { onmessage: ((e: { data: WorkletMessage }) => void) | null } }[] = []

/**
 * One loudness reading covers about 21ms of audio, which is what eight render
 * quanta come to at 48kHz.
 */
const LEVEL_MS = 21

/** How long a sound may be treated as speech while producing no words. */
const NOISE_PATIENCE_MS = 4000

/** Room tone, and somebody talking. */
const QUIET_RMS = 0.001
const SPEECH_RMS = 0.2

/**
 * Feed the hook a stretch of audio at one loudness, as the worklet would.
 *
 * `crest` is the peak over the average within a reading. Around 2 is a voice.
 * A collision — a key bottoming out, a tap on a trackpad — is nearly all peak.
 */
function hear(rms: number, ms: number, crest = 2): void {
  const port = worklets[worklets.length - 1]?.port
  act(() => {
    for (let elapsed = 0; elapsed < ms; elapsed += LEVEL_MS) {
      port?.onmessage?.({ data: { type: 'level', rms, peak: rms * crest, ms: LEVEL_MS } })
    }
  })
}

/** What a keyboard sounds like: loud for an instant, silent either side. */
const CLICK_CREST = 12

function stubBrowserAudio(): void {
  const track = { stop: vi.fn() }
  const stream = { getTracks: () => [track] } as unknown as MediaStream
  vi.stubGlobal('navigator', {
    mediaDevices: { getUserMedia: vi.fn().mockResolvedValue(stream) },
  })
  vi.stubGlobal('AudioWorkletNode', class {
    port: { onmessage: ((e: { data: WorkletMessage }) => void) | null } = { onmessage: null }
    connect = vi.fn().mockReturnValue({ connect: vi.fn() })
    constructor() { worklets.push(this) }
  })
  vi.stubGlobal('AudioContext', class {
    // Real contexts run at whatever the output device negotiated, and the server
    // has to decode against that number rather than assume one. A fake without
    // it cannot catch a client that stops declaring its rate.
    sampleRate = capturedSampleRate
    audioWorklet = { addModule: vi.fn().mockResolvedValue(undefined) }
    destination = {}
    createMediaStreamSource = vi.fn().mockReturnValue({ connect: vi.fn() })
    createGain = vi.fn().mockReturnValue({ gain: { value: 1 }, connect: vi.fn().mockReturnValue({ connect: vi.fn() }) })
    close = vi.fn().mockResolvedValue(undefined)
  })
  vi.stubGlobal('WebSocket', FakeWebSocket)
}

function setup(composerStart = '') {
  let composer = composerStart
  const setComposerText = vi.fn((text: string) => { composer = text })
  const onError = vi.fn()
  const hook = renderHook(() =>
    useDictation({
      tenantId: 'tenant-1',
      surface: 'agent_chat',
      agentId: 'agent-1',
      getComposerText: () => composer,
      setComposerText,
      onError,
    }),
  )
  return { hook, setComposerText, onError, read: () => composer }
}

function setupConversation() {
  let composer = ''
  const setComposerText = vi.fn((t: string) => { composer = t })
  const onError = vi.fn()
  const onUtterance = vi.fn()
  const onSpeechStart = vi.fn()
  const onSpeechDiscarded = vi.fn()
  const hook = renderHook(() =>
    useDictation({
      tenantId: 'tenant-1',
      surface: 'agent_chat',
      agentId: 'agent-1',
      getComposerText: () => composer,
      setComposerText,
      onError,
      mode: 'conversation',
      onUtterance,
      onSpeechStart,
      onSpeechDiscarded,
    }),
  )
  return { hook, onUtterance, onSpeechStart, onSpeechDiscarded, read: () => composer }
}

describe('useDictation (conversation)', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    capturedSampleRate = 48000
    worklets.length = 0
    stubBrowserAudio()
  })
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('TELLS THE SERVER WHAT RATE IT IS CAPTURING AT', async () => {
    // The worklet forwards samples at the context's rate without resampling
    // them, so the server can only decode correctly if it is told. It used to
    // assume 48000 for everybody: measured against the recogniser, a headset's
    // 16 kHz read as 48 kHz produced an empty transcript and a session that
    // reported hearing no audio at all.
    capturedSampleRate = 16000
    const { hook } = setupConversation()
    await act(async () => { await hook.result.current.toggle() })
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    const url = new URL(FakeWebSocket.instances[0].url)
    expect(url.searchParams.get('sampleRate')).toBe('16000')
  })

  it('declares the ordinary desktop rate too, rather than relying on a default', async () => {
    const { hook } = setupConversation()
    await act(async () => { await hook.result.current.toggle() })
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    const url = new URL(FakeWebSocket.instances[0].url)
    expect(url.searchParams.get('sampleRate')).toBe('48000')
  })

  it('sends the turn when the recogniser says the speaker stopped', async () => {
    const { hook, onUtterance } = setupConversation()
    await act(async () => { await hook.result.current.toggle() })
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.instances[0]

    act(() => { socket.emit({ type: 'final', transcript: 'what happened to the forecast' }) })
    act(() => { socket.emit({ type: 'speech_end' }) })

    expect(onUtterance).toHaveBeenCalledWith('what happened to the forecast', true)
  })

  it('sends the turn even when that event never arrives', async () => {
    // The whole point of the fallback. Without it a conversation waits forever
    // and the person ends up pressing send by hand, which is not a conversation.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { hook, onUtterance } = setupConversation()
    await act(async () => { await hook.result.current.toggle() })
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    act(() => {
      FakeWebSocket.instances[0].emit({ type: 'final', transcript: 'show me last quarter' })
    })
    expect(onUtterance).not.toHaveBeenCalled()

    act(() => { vi.advanceTimersByTime(1500) })
    expect(onUtterance).toHaveBeenCalledWith('show me last quarter', true)
  })

  it('does not cut someone off who is still talking', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { hook, onUtterance } = setupConversation()
    await act(async () => { await hook.result.current.toggle() })
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.instances[0]

    act(() => { socket.emit({ type: 'final', transcript: 'first part' }) })
    act(() => { vi.advanceTimersByTime(800) })
    // Still going: the timer restarts rather than firing.
    act(() => { socket.emit({ type: 'final', transcript: 'second part' }) })
    act(() => { vi.advanceTimersByTime(800) })
    expect(onUtterance).not.toHaveBeenCalled()

    act(() => { vi.advanceTimersByTime(600) })
    expect(onUtterance).toHaveBeenCalledWith('first part second part', true)
  })

  it('reports a noise that produced no words, and sends nothing', async () => {
    const { hook, onUtterance, onSpeechStart, onSpeechDiscarded } = setupConversation()
    await act(async () => { await hook.result.current.toggle() })
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.instances[0]

    act(() => { socket.emit({ type: 'interim', transcript: 'hmm' }) })
    expect(onSpeechStart).toHaveBeenCalled()

    act(() => { socket.emit({ type: 'speech_end' }) })
    expect(onSpeechDiscarded).toHaveBeenCalled()
    expect(onUtterance).not.toHaveBeenCalled()
  })

  // Turn-taking timed by the room rather than by the network. The hook receives
  // loudness readings from the capture worklet and owns every judgement made
  // about them, which is what makes them reachable from here.
  describe('voice activity', () => {
    async function listening() {
      const conversation = setupConversation()
      await act(async () => { await conversation.hook.result.current.toggle() })
      await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
      return { ...conversation, socket: FakeWebSocket.instances[0] }
    }

    it('ends the turn 700ms after the room goes quiet', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const { socket, onUtterance } = await listening()

      hear(SPEECH_RMS, 400)
      act(() => { socket.emit({ type: 'final', transcript: 'book it for tuesday' }) })
      hear(QUIET_RMS, 700)
      // The room is quiet; the recogniser gets its moment to catch up.
      expect(onUtterance).not.toHaveBeenCalled()

      act(() => { vi.advanceTimersByTime(250) })
      expect(onUtterance).toHaveBeenCalledWith('book it for tuesday', true)
    })

    it('reports speech before a single transcript has crossed the network', async () => {
      const { onSpeechStart } = await listening()

      hear(SPEECH_RMS, 100)
      expect(onSpeechStart).not.toHaveBeenCalled()

      // This is the whole point of listening to the room: the reply is turned
      // down on the sound itself, hundreds of milliseconds before the words
      // that prove it was speech arrive.
      hear(SPEECH_RMS, 150)
      expect(onSpeechStart).toHaveBeenCalledTimes(1)
    })

    it('does not cut off someone who paused for breath', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const { socket, onUtterance } = await listening()

      hear(SPEECH_RMS, 400)
      act(() => { socket.emit({ type: 'final', transcript: 'move the review' }) })
      hear(QUIET_RMS, 700)
      // Off again before the turn closed. The silence was a pause, not an end.
      hear(SPEECH_RMS, 200)
      act(() => { vi.advanceTimersByTime(400) })
      expect(onUtterance).not.toHaveBeenCalled()

      act(() => { socket.emit({ type: 'final', transcript: 'to thursday' }) })
      hear(QUIET_RMS, 700)
      act(() => { vi.advanceTimersByTime(250) })
      expect(onUtterance).toHaveBeenCalledWith('move the review to thursday', true)
    })

    it('waits for the tail of the sentence rather than truncating it', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const { socket, onUtterance } = await listening()

      hear(SPEECH_RMS, 400)
      act(() => { socket.emit({ type: 'final', transcript: 'what did payroll cost' }) })
      hear(QUIET_RMS, 700)

      // The microphone knew the turn was over before the recogniser did. Words
      // still landing mean it is behind, not that anyone is still speaking.
      act(() => { vi.advanceTimersByTime(200) })
      act(() => { socket.emit({ type: 'final', transcript: 'last quarter' }) })
      act(() => { vi.advanceTimersByTime(200) })
      expect(onUtterance).not.toHaveBeenCalled()

      act(() => { vi.advanceTimersByTime(100) })
      expect(onUtterance).toHaveBeenCalledWith('what did payroll cost last quarter', true)
    })

    it('sends nothing when the noise produced no words', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const { onUtterance, onSpeechDiscarded } = await listening()

      // A door, a chair, a cough: loud enough to duck a reply, never a turn.
      hear(SPEECH_RMS, 200)
      hear(QUIET_RMS, 700)
      act(() => { vi.advanceTimersByTime(250) })

      expect(onUtterance).not.toHaveBeenCalled()
      // And the reply that was turned down on the strength of it is released.
      expect(onSpeechDiscarded).toHaveBeenCalled()
    })

    // A desk is full of things that are not voices, and every one of them is
    // louder than a voice for a moment and then gone.
    it('does not hear a keyboard, however long the typing goes on', async () => {
      const { onSpeechStart } = await listening()

      // Fast typing puts a click into nearly every reading, so waiting for the
      // noise to stop is not a filter: the loudness IS sustained. What is never
      // sustained is the sound itself. Each reading is a spike over silence.
      hear(SPEECH_RMS, 600, CLICK_CREST)

      expect(onSpeechStart).not.toHaveBeenCalled()
    })

    it('hears a voice at the same loudness the keyboard reached', async () => {
      // The pair that proves it is the SHAPE being rejected and not the volume.
      // Identical rms to the test above, shaped like a voice instead of a
      // collision, and this one is somebody talking.
      const { onSpeechStart } = await listening()
      hear(SPEECH_RMS, 600)
      expect(onSpeechStart).toHaveBeenCalledTimes(1)
    })

    it('does not hear a trackpad tap, however loud', async () => {
      const { onSpeechStart } = await listening()
      hear(SPEECH_RMS * 4, 400, CLICK_CREST)
      expect(onSpeechStart).not.toHaveBeenCalled()
    })

    it('is not deafened by someone typing while they talk', async () => {
      const { socket, onUtterance } = await listening()

      // Once a voice is established the clicks are let through, because the
      // alternative is cutting a sentence in half at the keyboard.
      hear(SPEECH_RMS, 250)
      act(() => { socket.emit({ type: 'final', transcript: 'add it to the list' }) })
      hear(SPEECH_RMS, 100, CLICK_CREST)
      hear(SPEECH_RMS, 200)
      act(() => { socket.emit({ type: 'speech_end' }) })

      expect(onUtterance).toHaveBeenCalledWith('add it to the list', true)
    })

    it('gives up on a noisy room, and stops hearing it as speech', async () => {
      const { onUtterance, onSpeechStart, onSpeechDiscarded } = await listening()

      // A fan, or gain control lifting room tone until it crosses the quietest
      // sound that may be called speech. Loudness alone cannot tell this from a
      // person, and it is honest to say so: the sound IS taken for speech at
      // first, and the reply is turned down.
      for (let step = 1; step <= 40; step += 1) hear(QUIET_RMS * step, LEVEL_MS * 4)
      expect(onSpeechStart).toHaveBeenCalled()

      // What must not happen is that it stays that way. The recogniser produced
      // nothing, so the sound is written off, the reply is released, and the
      // floor moves up to where the noise lives.
      hear(QUIET_RMS * 40, NOISE_PATIENCE_MS)
      expect(onSpeechDiscarded).toHaveBeenCalled()

      // Same room, same noise, no longer mistaken for anybody.
      onSpeechStart.mockClear()
      hear(QUIET_RMS * 40, 2000)
      expect(onSpeechStart).not.toHaveBeenCalled()
      // And at no point was a turn sent, because no words were ever said.
      expect(onUtterance).not.toHaveBeenCalled()
    })

    it('does not duck a reply because the recogniser hallucinated', async () => {
      const { socket, onSpeechStart } = await listening()

      // The room has been reporting, and it heard nothing. A recogniser fed
      // keyboard noise still returns words now and then, and three characters
      // used to be the entire test for "somebody is interrupting".
      hear(QUIET_RMS, 200)
      act(() => { socket.emit({ type: 'interim', transcript: 'the' }) })

      expect(onSpeechStart).not.toHaveBeenCalled()
    })

    it('does not turn a word it invented into a turn', async () => {
      // The room stayed quiet and the recogniser produced a word anyway, which
      // is what a recogniser does in a room with a keyboard in it. One of these
      // used to stop a reply dead, abort the run behind it, and get sent.
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const { socket, onUtterance } = await listening()

      hear(QUIET_RMS, 300)
      act(() => { socket.emit({ type: 'final', transcript: 'the' }) })
      act(() => { vi.advanceTimersByTime(1500) })

      expect(onUtterance).not.toHaveBeenCalled()
    })

    it('still ends the turn of somebody too quiet to detect', async () => {
      // Gating the transcript path on the detector opens a hole underneath it:
      // a soft speaker the detector never calls speech, whose words the
      // recogniser hears anyway, would have nothing left to end their turn.
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const { socket, onUtterance } = await listening()

      hear(QUIET_RMS, 200)
      act(() => { socket.emit({ type: 'final', transcript: 'a quiet question' }) })
      act(() => { vi.advanceTimersByTime(1500) })

      expect(onUtterance).toHaveBeenCalledWith('a quiet question', false)
    })

    it('publishes a level that rises with the voice and falls to nothing', async () => {
      const { hook } = await listening()
      expect(hook.result.current.levelRef.current).toBe(0)

      hear(0.02, 200)
      const quietTalking = hook.result.current.levelRef.current
      hear(0.2, 200)
      const loudTalking = hook.result.current.levelRef.current

      // Expressive rather than binary: amplitude is logarithmic, and a ring
      // drawn from it directly pegs on every syllable.
      expect(quietTalking).toBeGreaterThan(0)
      expect(quietTalking).toBeLessThan(0.75)
      expect(loudTalking).toBeGreaterThan(quietTalking)

      // Nothing below the speech threshold, so the ring is not a room detector.
      hear(QUIET_RMS, 100)
      expect(hook.result.current.levelRef.current).toBe(0)
    })

    it('measures silence in audio, so a slow network cannot hold a turn open', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      const { socket, onUtterance } = await listening()

      hear(SPEECH_RMS, 400)
      act(() => { socket.emit({ type: 'final', transcript: 'ship it' }) })
      hear(QUIET_RMS, 700)
      act(() => { vi.advanceTimersByTime(250) })

      // The transcript-timed fallback would still have 950ms to run here.
      expect(onUtterance).toHaveBeenCalledWith('ship it', true)
    })
  })

  it('still sends audio when voice mode restarts an armed microphone', async () => {
    // Voice mode cannot convert a live session in place — the mode is in the
    // socket URL — so it stops the old one and starts a new one. The stop is a
    // half-close, which sets the flag that gates the audio upload; a restart
    // that inherits it opens a session that listens to nothing forever.
    const { hook } = setupConversation()
    await act(async () => { await hook.result.current.toggle() })
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    await act(async () => {
      hook.result.current.stop()
      await hook.result.current.start()
    })
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))

    const socket = FakeWebSocket.instances[1]
    act(() => { worklets[worklets.length - 1].port.onmessage?.({ data: new ArrayBuffer(8) }) })

    expect(socket.sent).toHaveLength(1)
    // And the predecessor is gone rather than lingering with the microphone open.
    expect(FakeWebSocket.instances[0].readyState).toBe(3)
  })

  it('ignores a sound too short to be a word', async () => {
    const { hook, onSpeechStart } = setupConversation()
    await act(async () => { await hook.result.current.toggle() })
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    // A keyboard press recognises as a stray character or two. Treating that as
    // someone interrupting is what turned every keystroke into a hesitation.
    act(() => { FakeWebSocket.instances[0].emit({ type: 'interim', transcript: 'k' }) })
    expect(onSpeechStart).not.toHaveBeenCalled()
  })
})

describe('useDictation (streaming)', () => {
  beforeEach(() => {
    FakeWebSocket.instances = []
    worklets.length = 0
    stubBrowserAudio()
  })
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('loads the capture worklet from a same-origin path, not a blob', async () => {
    // The site's CSP allows scripts from 'self' only; a blob: URL is refused
    // before it loads and takes the microphone down with it.
    const addModule = vi.fn().mockResolvedValue(undefined)
    vi.stubGlobal('AudioContext', class {
      audioWorklet = { addModule }
      destination = {}
      createMediaStreamSource = vi.fn().mockReturnValue({ connect: vi.fn() })
      createGain = vi.fn().mockReturnValue({ gain: { value: 1 }, connect: vi.fn().mockReturnValue({ connect: vi.fn() }) })
      close = vi.fn().mockResolvedValue(undefined)
    })

    const { hook } = setup()
    await act(async () => { await hook.result.current.toggle() })

    expect(addModule).toHaveBeenCalledWith('/pcm-forwarder.worklet.js')
  })

  it('shows interim text while the person is still speaking', async () => {
    const { hook, read } = setup()

    await act(async () => { await hook.result.current.toggle() })
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    act(() => { FakeWebSocket.instances[0].emit({ type: 'interim', transcript: 'testing test' }) })

    // The whole point: words on screen before anyone pressed stop.
    expect(read()).toBe('testing test')
    expect(hook.result.current.isListening).toBe(true)
  })

  it('replaces the guess rather than appending to it', async () => {
    const { hook, read } = setup()
    await act(async () => { await hook.result.current.toggle() })
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.instances[0]

    act(() => { socket.emit({ type: 'interim', transcript: 'testing' }) })
    act(() => { socket.emit({ type: 'interim', transcript: 'testing testing one' }) })

    expect(read()).toBe('testing testing one')
  })

  it('keeps settled segments and drops the interim that preceded them', async () => {
    const { hook, read } = setup()
    await act(async () => { await hook.result.current.toggle() })
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.instances[0]

    act(() => { socket.emit({ type: 'interim', transcript: 'testing testin' }) })
    act(() => { socket.emit({ type: 'final', transcript: 'testing testing one two three' }) })
    act(() => { socket.emit({ type: 'interim', transcript: 'and four' }) })

    expect(read()).toBe('testing testing one two three and four')

    act(() => { socket.emit({ type: 'final', transcript: 'and four five' }) })
    expect(read()).toBe('testing testing one two three and four five')
  })

  it('appends to text already in the composer instead of replacing it', async () => {
    const { hook, read } = setup('Draft I started typing')
    await act(async () => { await hook.result.current.toggle() })
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    act(() => { FakeWebSocket.instances[0].emit({ type: 'final', transcript: 'and then said aloud' }) })

    expect(read()).toBe('Draft I started typing and then said aloud')
  })

  it('sends the token as a subprotocol, never in the url', async () => {
    const { hook } = setup()
    await act(async () => { await hook.result.current.toggle() })
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    const socket = FakeWebSocket.instances[0]
    expect(socket.protocols).toEqual(['voice', 'test-token'])
    // Query strings land in access logs; a bearer token has no business there.
    expect(socket.url).not.toContain('test-token')
    expect(socket.url).toContain('surface=agent_chat')
    expect(socket.url).toContain('agentId=agent-1')
  })

  it('half-closes on stop: asks the server to finish, stays open for the last words', async () => {
    const { hook } = setup()
    await act(async () => { await hook.result.current.toggle() })
    await waitFor(() => expect(hook.result.current.isListening).toBe(true))
    const socket = FakeWebSocket.instances[0]

    await act(async () => { await hook.result.current.toggle() })

    expect(hook.result.current.isListening).toBe(false)
    // The socket stays up: the recogniser settles the last segment only once it
    // knows no more audio is coming, and hanging up now would discard it.
    expect(socket.readyState).toBe(1)
    expect(socket.sent).toContainEqual(JSON.stringify({ type: 'stop' }))
  })

  it('keeps a final that arrives after stop', async () => {
    const { hook, read } = setup()
    await act(async () => { await hook.result.current.toggle() })
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))
    const socket = FakeWebSocket.instances[0]

    act(() => { socket.emit({ type: 'interim', transcript: 'let the team' }) })
    await act(async () => { await hook.result.current.toggle() })
    // Drained after the stop, exactly as the server sends it.
    act(() => { socket.emit({ type: 'final', transcript: 'let the team know' }) })
    act(() => { socket.close(1000, 'complete') })

    expect(read()).toBe('let the team know')
  })

  it('reports an abnormal close, and stays quiet on a normal one', async () => {
    const { hook, onError } = setup()
    await act(async () => { await hook.result.current.toggle() })
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(1))

    act(() => { FakeWebSocket.instances[0].onclose?.({ code: 4500, reason: 'upstream' }) })
    expect(onError).toHaveBeenCalledTimes(1)

    onError.mockClear()
    const second = setup()
    await act(async () => { await second.hook.result.current.toggle() })
    await waitFor(() => expect(FakeWebSocket.instances).toHaveLength(2))
    act(() => { FakeWebSocket.instances[1].onclose?.({ code: 1000, reason: 'done' }) })
    expect(second.onError).not.toHaveBeenCalled()
  })

  it('tells the person when the browser cannot record at all', async () => {
    vi.stubGlobal('AudioWorkletNode', undefined)
    const { hook, onError } = setup()

    await act(async () => { await hook.result.current.toggle() })

    expect(onError).toHaveBeenCalledWith('Your browser does not support microphone access.')
    expect(hook.result.current.isListening).toBe(false)
  })
})
