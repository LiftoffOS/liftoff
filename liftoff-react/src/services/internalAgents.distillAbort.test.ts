// Aborting a running distillation, at the wire.
//
// The stream had no way to be called off: it ran to completion whatever the
// UI did. The loading screen's back button needs it to actually stop, and it
// needs stopping to be silent. Reporting an abort through onError would put
// "Something went wrong" on the screen the person just moved to, and would
// file a cancel as a failure in the funnel.
//
// The second case here is a bug the abort work uncovered rather than caused:
// callers do not await this function, so a fetch that rejected outright (no
// network, a rejected token) escaped as an unhandled rejection and left the
// loading screen spinning with no error and no retry.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

vi.mock('./api', () => ({
  api: { get: vi.fn(), post: vi.fn(), put: vi.fn(), patch: vi.fn(), delete: vi.fn() },
  ApiError: class ApiError extends Error {},
  API_BASE_URL: 'https://api.test',
}))

vi.mock('../config/firebase', () => ({ auth: { currentUser: null } }))

import { distillInternalAgentStream } from './internalAgents'

const INPUT = { role: 'Recruiter', responsibilities: 'Screen applicants.', integrations: [] }

function callbacks() {
  return {
    onProgress: vi.fn(),
    onComplete: vi.fn(),
    onError: vi.fn(),
    onSummaryReady: vi.fn(),
  }
}

/** A body that never finishes, so the call is still open when we abort it. */
function hangingResponse(signal: AbortSignal): Response {
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: () =>
          new Promise((_resolve, reject) => {
            const fail = () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' }))
            // Checked as well as subscribed: the abort can land while the call
            // is still awaiting its token, long before the first read, and a
            // listener added afterwards never hears it.
            if (signal.aborted) fail()
            else signal.addEventListener('abort', fail)
          }),
      }),
    },
  } as unknown as Response
}

/** A body that yields the given chunks, then closes. */
function bodyOf(...chunks: string[]): Response {
  const queue = [...chunks]
  return {
    ok: true,
    body: {
      getReader: () => ({
        read: () => {
          const next = queue.shift()
          return Promise.resolve(
            next === undefined
              ? { done: true }
              : { done: false, value: new TextEncoder().encode(next) },
          )
        },
      }),
    },
  } as unknown as Response
}

const realFetch = globalThis.fetch
beforeEach(() => { globalThis.fetch = vi.fn() as unknown as typeof fetch })
afterEach(() => { globalThis.fetch = realFetch })

describe('distillInternalAgentStream abort', () => {
  it('passes the signal through to fetch', async () => {
    const run = new AbortController()
    vi.mocked(globalThis.fetch).mockImplementation(() =>
      Promise.resolve(hangingResponse(run.signal)),
    )

    const cb = callbacks()
    const pending = distillInternalAgentStream('t1', INPUT, cb, run.signal)
    run.abort()
    await pending

    expect(vi.mocked(globalThis.fetch).mock.calls[0][1]).toMatchObject({ signal: run.signal })
  })

  it('stays silent when the read is aborted', async () => {
    const run = new AbortController()
    vi.mocked(globalThis.fetch).mockImplementation(() =>
      Promise.resolve(hangingResponse(run.signal)),
    )

    const cb = callbacks()
    const pending = distillInternalAgentStream('t1', INPUT, cb, run.signal)
    run.abort()
    await pending

    // A distillation someone walked away from has not failed.
    expect(cb.onError).not.toHaveBeenCalled()
    expect(cb.onComplete).not.toHaveBeenCalled()
  })

  it('stays silent when the request itself is aborted before it opens', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(
      Object.assign(new Error('The user aborted a request.'), { name: 'AbortError' }),
    )

    const cb = callbacks()
    await distillInternalAgentStream('t1', INPUT, cb, AbortSignal.abort())

    expect(cb.onError).not.toHaveBeenCalled()
  })

  it('reports a failure to open the stream instead of rejecting unhandled', async () => {
    vi.mocked(globalThis.fetch).mockRejectedValue(new TypeError('Failed to fetch'))

    const cb = callbacks()
    // The regression: this rejected, so the screen kept spinning with no retry.
    await expect(distillInternalAgentStream('t1', INPUT, cb)).resolves.toBeUndefined()
    expect(cb.onError).toHaveBeenCalledWith({ message: 'Failed to fetch' })
  })

  it('still works with no signal at all', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValue(
      bodyOf('event: complete\ndata: {"agentType":"agent","summary":"s","distillId":"d1"}\n\n'),
    )

    const cb = callbacks()
    await distillInternalAgentStream('t1', INPUT, cb)

    expect(cb.onError).not.toHaveBeenCalled()
    expect(vi.mocked(globalThis.fetch).mock.calls[0][1]).toMatchObject({ signal: undefined })
  })

  describe('a stream that ends without saying how', () => {
    it('reports a failure when the connection closes mid-build', async () => {
      // `done: true` on a stream that never sent complete or error used to
      // return silently, leaving the progress screen running forever. A
      // dropped connection, a proxy idle timeout and a backend that dies
      // mid-generation all look exactly like this from here.
      vi.mocked(globalThis.fetch).mockResolvedValue(
        bodyOf('event: progress\ndata: {"stage":"generating"}\n\n'),
      )

      const cb = callbacks()
      await distillInternalAgentStream('t1', INPUT, cb)

      expect(cb.onProgress).toHaveBeenCalledWith('generating')
      expect(cb.onError).toHaveBeenCalledWith({
        message: 'The connection closed before the build finished. Please try again.',
      })
    })

    it('reads a final event that never got its trailing newline', async () => {
      // Closing straight after the last line strands it: the parser holds the
      // trailing fragment back for a chunk that never arrives.
      vi.mocked(globalThis.fetch).mockResolvedValue(
        bodyOf('event: complete\ndata: {"agentType":"agent","summary":"s","distillId":"d1"}'),
      )

      const cb = callbacks()
      await distillInternalAgentStream('t1', INPUT, cb)

      expect(cb.onComplete).toHaveBeenCalled()
      expect(cb.onError).not.toHaveBeenCalled()
    })

    it('stays silent when the close was our own abort', async () => {
      vi.mocked(globalThis.fetch).mockResolvedValue(bodyOf())

      const cb = callbacks()
      await distillInternalAgentStream('t1', INPUT, cb, AbortSignal.abort())

      expect(cb.onError).not.toHaveBeenCalled()
    })
  })
})
