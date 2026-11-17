// Ducking has to be survivable, and for a long time it was not.
//
// Turning the volume down does not stop a reply. The context clock runs on, the
// scheduled chunks play out, and the words are spent whether or not anybody can
// hear them — so a second of ducking cost a second of the answer, and a reply
// that happened to finish while quiet closed its own session and left nothing
// to come back to. What you heard was an agent stopping mid-sentence at a noise
// and never resuming.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { SpeechSession } from './voiceSpeech'

vi.mock('../config/firebase', () => ({
  auth: { currentUser: { getIdToken: () => Promise.resolve('test-token') } },
}))

/** Every source the session scheduled, in the order it scheduled them. */
const scheduled: { startAt: number; ended: () => void }[] = []

class FakeSocket {
  static instances: FakeSocket[] = []
  readyState = 1
  binaryType = ''
  sent: unknown[] = []
  onopen: (() => void) | null = null
  onmessage: ((e: { data: string | ArrayBuffer }) => void) | null = null
  onerror: (() => void) | null = null
  onclose: ((e: { code: number; reason: string }) => void) | null = null
  constructor() {
    FakeSocket.instances.push(this)
    setTimeout(() => this.onopen?.(), 0)
  }
  send(d: unknown) { this.sent.push(d) }
  close() { this.readyState = 3 }
  /** One chunk of speech audio from the server. */
  speak(samples = 4800) { this.onmessage?.({ data: new ArrayBuffer(samples * 2) }) }
  say(payload: unknown) { this.onmessage?.({ data: JSON.stringify(payload) }) }
}

function stubAudio(): void {
  vi.stubGlobal('WebSocket', FakeSocket)
  vi.stubGlobal('AudioContext', class {
    currentTime = 0
    state = 'running'
    destination = {}
    close = vi.fn().mockResolvedValue(undefined)
    createGain = () => ({
      gain: { value: 1, cancelScheduledValues: vi.fn(), setTargetAtTime: vi.fn() },
      connect: vi.fn(),
    })
    createBuffer = (_c: number, length: number, rate: number) => ({
      duration: length / rate,
      getChannelData: () => new Float32Array(length),
    })
    createBufferSource = () => {
      const source = {
        buffer: null as { duration: number } | null,
        connect: vi.fn(),
        stop: vi.fn(),
        onended: null as (() => void) | null,
        start(at: number) {
          scheduled.push({ startAt: at, ended: () => source.onended?.() })
        },
      }
      return source
    }
  })
}

async function openSession() {
  const session = await SpeechSession.open({
    tenantId: 'tenant-1',
    surface: 'agent_chat',
    agentId: 'agent-1',
  })
  return { session, socket: FakeSocket.instances[FakeSocket.instances.length - 1] }
}

beforeEach(() => {
  scheduled.length = 0
  FakeSocket.instances = []
  stubAudio()
})
afterEach(() => vi.unstubAllGlobals())

describe('SpeechSession ducking', () => {
  it('holds the reply instead of playing it to nobody', async () => {
    const { session, socket } = await openSession()
    socket.say({ type: 'ready', sampleRate: 24000 })

    socket.speak()
    expect(scheduled).toHaveLength(1)

    // Somebody might be talking. Everything after this is kept, not spent.
    session.duck()
    socket.speak()
    socket.speak()
    expect(scheduled).toHaveLength(1)

    // It was nothing, so the answer carries on from where it left off rather
    // than from wherever the clock happens to have reached.
    session.unduck()
    expect(scheduled).toHaveLength(3)
  })

  it('does not end a reply that went quiet before it finished', async () => {
    // The failure that reads as "it stopped and never came back": while ducked,
    // the scheduled audio drains, the server says it is done, and the session
    // decides it has played out — closing over a queue nobody ever heard.
    const onFinished = vi.fn()
    const session = await SpeechSession.open({
      tenantId: 'tenant-1', surface: 'agent_chat', agentId: 'agent-1', onFinished,
    })
    const socket = FakeSocket.instances[FakeSocket.instances.length - 1]
    socket.say({ type: 'ready', sampleRate: 24000 })

    socket.speak()
    session.duck()
    socket.speak()

    // Everything that was scheduled finishes playing, and the server is done.
    scheduled.forEach((s) => s.ended())
    socket.say({ type: 'done' })

    expect(onFinished).not.toHaveBeenCalled()
    expect(session.speaking).toBe(true)

    session.unduck()
    expect(scheduled).toHaveLength(2)
    scheduled.forEach((s) => s.ended())
    expect(onFinished).toHaveBeenCalled()
  })

  it('still counts as speaking while it is holding audio', async () => {
    // Barge-in asks this question. A session with a queue is mid-reply, and
    // answering "no" would send the interruption nowhere.
    const { session, socket } = await openSession()
    socket.say({ type: 'ready', sampleRate: 24000 })
    session.duck()
    socket.speak()
    scheduled.forEach((s) => s.ended())

    expect(session.speaking).toBe(true)
  })

  it('throws the queue away when the reply is genuinely interrupted', async () => {
    const { session, socket } = await openSession()
    socket.say({ type: 'ready', sampleRate: 24000 })
    session.duck()
    socket.speak()

    session.stop()

    expect(session.speaking).toBe(false)
    // A stopped session does not resurrect its queue on the way out.
    session.unduck()
    expect(scheduled).toHaveLength(0)
  })
})
