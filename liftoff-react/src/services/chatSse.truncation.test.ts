// A stream that ends without saying it finished is not a stream that finished.
//
// `reader.read()` reporting `done` means the body ended. It does not say why,
// and the two reasons are opposites: the turn completed, or the connection was
// cut underneath it. Both used to `break` out of the loop and resolve as a
// success, so a truncated stream was reported to the caller as a completed one
// and the person was told nothing at all. Every chat stream router now ends
// with an explicit `event: done` frame; its ABSENCE at EOF is the signal.

import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('../config/firebase', () => ({
  auth: { currentUser: { getIdToken: async () => 'test-token' } },
}))

import { streamChatSse, type ChatStreamError } from './chatSse'

/** A Response whose body streams `chunks` and then ends. */
function sseResponse(chunks: string[]): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    },
  })
  return new Response(body, {
    status: 200,
    headers: { 'Content-Type': 'text/event-stream' },
  })
}

async function run() {
  const events: Array<[string, Record<string, unknown>]> = []
  const errors: ChatStreamError[] = []
  await streamChatSse(
    '/api/agent-chat/x/chat-stream',
    {},
    (event, data) => events.push([event, data]),
    err => errors.push(err),
  )
  return { events, errors }
}

describe('streamChatSse tells a finished stream from a cut one', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  it('reports nothing when the server said it was done', async () => {
    const { events, errors } = await runWith([
      'event: text_delta\ndata: {"text":"hi"}\n\n',
      'event: complete\ndata: {"message":null}\n\n',
      'event: done\ndata: {}\n\n',
    ])
    expect(errors).toEqual([])
    expect(events.map(([e]) => e)).toEqual(['text_delta', 'complete'])
  })

  it('does not dispatch the done frame to the surface', async () => {
    // It is a transport marker. No surface has a handler for it, and routing it
    // onto one would only invite a fifth spelling of "terminal".
    const { events } = await runWith(['event: done\ndata: {}\n\n'])
    expect(events).toEqual([])
  })

  it('reports STREAM_TRUNCATED when the body just stops', async () => {
    // The failure the person actually experiences: an indicator running with a
    // dead socket behind it, and no way to tell that from a slow reply.
    const { errors } = await runWith([
      'event: thinking\ndata: {}\n\n',
      'event: text_delta\ndata: {"text":"partial"}\n\n',
    ])
    expect(errors).toHaveLength(1)
    expect(errors[0].code).toBe('STREAM_TRUNCATED')
  })

  it('stays quiet when a terminal frame arrived but done did not', async () => {
    // A socket dying in the gap between `complete` and `done` must not fire a
    // failure on a turn the person already has the answer to. `complete` and
    // `error` are the two frames every surface's vocabulary shares.
    for (const terminal of [
      'event: complete\ndata: {"message":null}\n\n',
      'event: error\ndata: {"code":"EXEC_ERROR","message":"nope"}\n\n',
    ]) {
      const { errors } = await runWith([terminal])
      expect(errors.filter(e => e.code === 'STREAM_TRUNCATED')).toEqual([])
    }
  })

  it('stays quiet on an interrupt acknowledgment followed by done', async () => {
    // A mid-run message is acknowledged with `interrupt_delivered` and nothing
    // else: no reply follows, because the reply belongs to the turn already
    // running. That frame is NOT in the terminal set and must not be — only the
    // server can say the stream is over. So `done` is what closes this shape,
    // and for as long as Liftoff's and Insights' acknowledgment exits ended the
    // socket above the `finally` that writes it, steering a running turn raised
    // "The connection dropped before the reply finished arriving." on a message
    // that HAD been delivered. Today's body without the `done` frame is the
    // second assertion.
    const { events, errors } = await runWith([
      'event: interrupt_delivered\ndata: {}\n\n',
      'event: done\ndata: {}\n\n',
    ])
    expect(errors).toEqual([])
    expect(events.map(([e]) => e)).toEqual(['interrupt_delivered'])

    const bare = await runWith(['event: interrupt_delivered\ndata: {}\n\n'])
    expect(bare.errors.map(e => e.code)).toEqual(['STREAM_TRUNCATED'])
  })

  it('says nothing extra when the caller aborted', async () => {
    // An abort is the caller's own doing, and a toast for a deliberate Stop or
    // navigation is noise.
    const controller = new AbortController()
    controller.abort()
    const errors: ChatStreamError[] = []
    vi.mocked(fetch).mockRejectedValueOnce(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    )
    await streamChatSse('/p', {}, () => {}, err => errors.push(err), controller.signal)
    expect(errors).toEqual([])
  })
})

/** Runs one stream, stubbing fetch to return it. */
async function runWith(chunks: string[]) {
  vi.mocked(fetch).mockResolvedValueOnce(sseResponse(chunks))
  return await run()
}

describe('a deliberate Stop is not a truncation', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn())
  })

  it('stays silent when the close races the abort', async () => {
    // An abort normally rejects the pending read. A Stop landing in the same
    // tick as the close arrives as a clean EOF instead: `done`, no terminal
    // frame, nothing wrong. Toasting there would fire a failure every time
    // somebody pressed Stop at the wrong moment.
    const controller = new AbortController()
    vi.mocked(fetch).mockResolvedValueOnce(
      sseResponse(['event: text_delta\ndata: {"text":"partial"}\n\n']),
    )
    const errors: ChatStreamError[] = []
    controller.abort()
    await streamChatSse('/p', {}, () => {}, err => errors.push(err), controller.signal)
    expect(errors).toEqual([])
  })
})
