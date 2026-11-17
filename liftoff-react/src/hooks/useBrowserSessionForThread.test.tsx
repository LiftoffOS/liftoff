import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import type { BrowserSession } from '../types/browserSession'

const ensureSessionMock = vi.fn()
const getActiveSessionMock = vi.fn()
const endSessionMock = vi.fn()
const gotoMock = vi.fn()
const takeControlMock = vi.fn()
const releaseControlMock = vi.fn()
const setViewportMock = vi.fn()
vi.mock('../services/browserSessions', () => ({
  ensureSession: (...a: unknown[]) => ensureSessionMock(...a),
  getActiveSession: (...a: unknown[]) => getActiveSessionMock(...a),
  endSession: (...a: unknown[]) => endSessionMock(...a),
  goto: (...a: unknown[]) => gotoMock(...a),
  takeControl: (...a: unknown[]) => takeControlMock(...a),
  releaseControl: (...a: unknown[]) => releaseControlMock(...a),
  setViewport: (...a: unknown[]) => setViewportMock(...a),
}))
vi.mock('./useTenant', () => ({ useTenant: () => ({ currentTenant: { id: 'tenant-1' } }) }))
vi.mock('../config/firebase', () => ({
  auth: { currentUser: { getIdToken: async () => 'test-token' } },
}))

import { useBrowserSessionForThread, clampViewport, VIEWPORT_MAX, VIEWPORT_MIN, VIEWPORT_SEND_DEBOUNCE_MS } from './useBrowserSessionForThread'

function session(over: Partial<BrowserSession> = {}): BrowserSession {
  return {
    id: 'mock-session-id', tenantId: 'tenant-1', agentId: 'agent-1', threadId: 'thread-1',
    ownerAccountId: 'acc-1', owner: null, driver: null, vendor: 'anchor', vendorSessionId: 'v1',
    liveViewUrl: 'https://live', createdAt: '', lastUsedAt: '', expiresAt: '',
    closedAt: null, closedReason: null,
    takeoverState: 'none', takenOverAt: null, currentUrl: null,
    lastScreenshotSignedUrl: '', lastScreenshotAt: null,
    ...over,
  }
}

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  window.localStorage.clear()
})

describe('useBrowserSessionForThread', () => {
  describe('onSessionCreated callback', () => {
    // Production bug: agent's run_browser_task spawned a session, agent
    // replied "Done — the browser is now on nytimes.com", but the right
    // pane stayed closed because nothing on the frontend reacted to the
    // newly-created session. AgentChatPage passes onSessionCreated to
    // auto-open the pane; this test pins the contract that powers it.

    it('fires exactly once when a session first appears for the thread', async () => {
      const cb = vi.fn()
      // First refetch: no session. Second refetch: session present.
      getActiveSessionMock
        .mockResolvedValueOnce({ session: null, lastClosedSession: null })
        .mockResolvedValueOnce({ session: session(), lastClosedSession: null })

      const { result, rerender } = renderHook(
        ({ thread }: { thread: string }) =>
          useBrowserSessionForThread(thread, 'agent-1', { onSessionCreated: cb }),
        { wrapper: makeWrapper(), initialProps: { thread: 'thread-1' } },
      )

      // First query lands with null session → callback does NOT fire.
      await waitFor(() => expect(result.current.query.isSuccess).toBe(true))
      expect(cb).not.toHaveBeenCalled()

      // Force a refetch; the second response carries a session.
      await act(async () => { await result.current.query.refetch() })
      await waitFor(() => expect(cb).toHaveBeenCalledTimes(1))

      // Stable re-renders don't re-fire — gate dedupes by session id.
      rerender({ thread: 'thread-1' })
      rerender({ thread: 'thread-1' })
      expect(cb).toHaveBeenCalledTimes(1)
    })

    it('fires again when session goes away (e.g. ends) and a new one is spawned', async () => {
      const cb = vi.fn()
      getActiveSessionMock
        .mockResolvedValueOnce({ session: session({ id: 's-1' }), lastClosedSession: null })
        .mockResolvedValueOnce({ session: null, lastClosedSession: null })
        .mockResolvedValueOnce({ session: session({ id: 's-2' }), lastClosedSession: null })

      const { result } = renderHook(
        () => useBrowserSessionForThread('thread-1', 'agent-1', { onSessionCreated: cb }),
        { wrapper: makeWrapper() },
      )

      // First session arrives → fire.
      await waitFor(() => expect(cb).toHaveBeenCalledTimes(1))

      // Session goes away → no fire.
      await act(async () => { await result.current.query.refetch() })
      await waitFor(() => expect(result.current.query.data?.session).toBeNull())
      expect(cb).toHaveBeenCalledTimes(1)

      // Different session id appears → fire again.
      await act(async () => { await result.current.query.refetch() })
      await waitFor(() => expect(cb).toHaveBeenCalledTimes(2))
    })

    it('fires when the agent spawns a session (cross-instance SSE backstop path)', async () => {
      // Models the production scenario: agent calls run_browser_task on
      // tenant-runtime instance B, session is created in DB, but the SSE
      // listener on instance A never sees the EventEmitter broadcast. The
      // active-session query eventually refetches (90s interval, focus,
      // or post-chat-turn invalidate from AgentChatPage) and sees the
      // session. This effect fires regardless of whether the discovery
      // came from SSE or polling — that's the key resilience guarantee.
      const cb = vi.fn()
      getActiveSessionMock
        .mockResolvedValueOnce({ session: null, lastClosedSession: null })
        .mockResolvedValueOnce({ session: session({ id: 'agent-spawned' }), lastClosedSession: null })

      const { result } = renderHook(
        () => useBrowserSessionForThread('thread-1', 'agent-1', { onSessionCreated: cb }),
        { wrapper: makeWrapper() },
      )
      await waitFor(() => expect(result.current.query.isSuccess).toBe(true))
      expect(cb).not.toHaveBeenCalled()

      // Simulate the post-chat-turn invalidate that AgentChatPage fires
      // when chat.streaming transitions to null.
      await act(async () => { await result.current.query.refetch() })

      await waitFor(() => expect(cb).toHaveBeenCalledTimes(1))
    })

    it('does NOT fire on thread switch when the new thread already has a session', async () => {
      // Bug: previously when the user switched from a thread with one
      // session to a thread with a DIFFERENT existing session, the hook
      // saw the sessionId field change and treated it as a new-session
      // appearance, auto-opening the pane in the new thread. The user
      // explicitly switched conversations — pane should NOT re-open.
      const cb = vi.fn()
      getActiveSessionMock
        // thread-1 has an active session 'sess-A'
        .mockResolvedValueOnce({ session: session({ id: 'sess-A' }), lastClosedSession: null })
        // thread-2 has an active session 'sess-B'
        .mockResolvedValueOnce({ session: session({ id: 'sess-B' }), lastClosedSession: null })

      const { result, rerender } = renderHook(
        ({ thread }: { thread: string }) =>
          useBrowserSessionForThread(thread, 'agent-1', { onSessionCreated: cb }),
        { wrapper: makeWrapper(), initialProps: { thread: 'thread-1' } },
      )

      // First thread's session lands → callback fires once.
      await waitFor(() => expect(cb).toHaveBeenCalledTimes(1))

      // User switches to thread-2 which already has its own session.
      rerender({ thread: 'thread-2' })
      await waitFor(() => expect(result.current.query.data?.session?.id).toBe('sess-B'))

      // Callback must NOT fire again — pane stays closed.
      expect(cb).toHaveBeenCalledTimes(1)
    })

    it('does NOT fire when no callback is provided (option is truly optional)', async () => {
      getActiveSessionMock.mockResolvedValue({ session: session(), lastClosedSession: null })
      const { result } = renderHook(
        () => useBrowserSessionForThread('thread-1', 'agent-1'),
        { wrapper: makeWrapper() },
      )
      // Just assert it doesn't throw and the session lands.
      await waitFor(() => expect(result.current.query.data?.session?.id).toBe('mock-session-id'))
    })
  })

  // Speaking to the agent while holding its browser is an instruction to
  // act; the send hands the browser back first so the tools are not refused.
  describe('handBackIfDriving', () => {
    const me = { accountId: 'acc-2', firstName: 'Me', lastName: 'Here', email: 'me@example.com', avatarUrl: null, takenAt: '', present: true }

    it('releases the wheel when this viewer is driving, writes the released session into the cache, and resolves with the hold the release ended', async () => {
      getActiveSessionMock.mockResolvedValue({ session: session({ takeoverState: 'taken_over', driver: me }), lastClosedSession: null })
      releaseControlMock.mockResolvedValue({ session: session({ takeoverState: 'none', driver: null }), holdId: 'hold-1', releasedByDriver: true })
      const { result } = renderHook(() => useBrowserSessionForThread('thread-1', 'agent-1'), { wrapper: makeWrapper() })
      await waitFor(() => expect(result.current.query.data?.session?.takeoverState).toBe('taken_over'))
      getActiveSessionMock.mockResolvedValue({ session: session({ takeoverState: 'none', driver: null }), lastClosedSession: null })
      let holdId: string | null = null
      await act(async () => { holdId = await result.current.handBackIfDriving('acc-2') })
      expect(releaseControlMock).toHaveBeenCalledWith('tenant-1', 'mock-session-id')
      expect(holdId).toBe('hold-1')
      await waitFor(() => expect(result.current.query.data?.session?.takeoverState).toBe('none'))
    })

    it('resolves null when the release was not the driver\'s, or ended no hold: nothing is announced', async () => {
      getActiveSessionMock.mockResolvedValue({ session: session({ takeoverState: 'taken_over', driver: me }), lastClosedSession: null })
      releaseControlMock.mockResolvedValue({ session: session({ takeoverState: 'none', driver: null }), holdId: 'hold-1', releasedByDriver: false })
      const { result } = renderHook(() => useBrowserSessionForThread('thread-1', 'agent-1'), { wrapper: makeWrapper() })
      await waitFor(() => expect(result.current.query.data?.session?.takeoverState).toBe('taken_over'))
      let holdId: string | null = 'unset'
      await act(async () => { holdId = await result.current.handBackIfDriving('acc-2') })
      expect(holdId).toBeNull()
    })

    it('does nothing, and resolves null, when nobody holds the wheel, or somebody else does', async () => {
      getActiveSessionMock.mockResolvedValue({ session: session({ takeoverState: 'taken_over', driver: { ...me, accountId: 'acc-9' } }), lastClosedSession: null })
      const { result } = renderHook(() => useBrowserSessionForThread('thread-1', 'agent-1'), { wrapper: makeWrapper() })
      await waitFor(() => expect(result.current.query.data?.session).toBeTruthy())
      let holdId: string | null = 'unset'
      await act(async () => { holdId = await result.current.handBackIfDriving('acc-2') })
      expect(releaseControlMock).not.toHaveBeenCalled()
      expect(holdId).toBeNull()
    })

    it('a failed release resolves null anyway: the send goes on and the runtime says what it refused', async () => {
      getActiveSessionMock.mockResolvedValue({ session: session({ takeoverState: 'taken_over', driver: me }), lastClosedSession: null })
      releaseControlMock.mockRejectedValue(new Error('503'))
      const { result } = renderHook(() => useBrowserSessionForThread('thread-1', 'agent-1'), { wrapper: makeWrapper() })
      await waitFor(() => expect(result.current.query.data?.session?.takeoverState).toBe('taken_over'))
      let holdId: string | null = 'unset'
      await act(async () => { holdId = await result.current.handBackIfDriving('acc-2') })
      expect(holdId).toBeNull()
    })

    it('taking the wheel names the thread and its surface, so the backend can refuse a wheel another person holds', async () => {
      getActiveSessionMock.mockResolvedValue({ session: session(), lastClosedSession: null })
      takeControlMock.mockResolvedValue({ session: session({ takeoverState: 'taken_over', driver: me }) })
      const { result } = renderHook(() => useBrowserSessionForThread('thread-1', null, { surface: 'liftoff' }), { wrapper: makeWrapper() })
      await waitFor(() => expect(result.current.query.data?.session).toBeTruthy())
      await act(async () => { await result.current.controlMutation.mutateAsync({ sessionId: 'mock-session-id', take: true }) })
      expect(takeControlMock).toHaveBeenCalledWith('tenant-1', 'mock-session-id', { threadId: 'thread-1', surface: 'liftoff' })
    })
  })

  describe('the viewport follows the pane', () => {
    it('brings a measured size inside [640, 1920] x [480, 1200] and rounds it to 2', () => {
      expect(clampViewport({ width: 900.6, height: 700.2 })).toEqual({ width: 900, height: 700 })
      expect(clampViewport({ width: 401, height: 301 })).toEqual({ width: 640, height: 480 })
      expect(clampViewport({ width: 3000, height: 2000 })).toEqual({ width: 1800, height: 1200 })
      expect(clampViewport({ width: 801, height: 601 })).toEqual({ width: 800, height: 600 })
    })

    // The runtime lays the page out at the shape it is given and maps a point
    // through it; a size clamped per axis hands it a shape the live view does
    // not have. At the 480px default the wrap measures 455x312, which used to
    // come out 640x480 — 4:3, from a 1.46 box — and the runtime doubled that
    // to 1280x960. Every pane under ~725px did it.
    it('keeps the pane\'s shape whatever bound it has to clear', () => {
      const ratio = (s: { width: number; height: number }) => s.width / s.height
      for (const measured of [
        { width: 455, height: 312 }, // the 480px default pane
        { width: 336, height: 230 }, // the 360px minimum
        { width: 700, height: 480 }, // the first size that clears both floors
        { width: 3000, height: 2000 }, // over both ceilings
        { width: 1000, height: 300 }, // wide enough that the height floor binds against a ceiling
      ]) {
        const got = clampViewport(measured)
        expect(Math.abs(ratio(got) - ratio(measured))).toBeLessThan(0.01)
        expect(got.width).toBeGreaterThanOrEqual(VIEWPORT_MIN.width)
        expect(got.height).toBeGreaterThanOrEqual(VIEWPORT_MIN.height)
        expect(got.width).toBeLessThanOrEqual(VIEWPORT_MAX.width)
        expect(got.height).toBeLessThanOrEqual(VIEWPORT_MAX.height)
        expect(got.width % 2).toBe(0)
        expect(got.height % 2).toBe(0)
      }
    })

    it('sends the pane\'s size with ensure, and to the session once per settled resize, 300 ms after the last change', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true })
      try {
        getActiveSessionMock.mockResolvedValue({ session: null, lastClosedSession: null })
        ensureSessionMock.mockResolvedValue({ session: session(), wasNewlyCreated: true, error: null, lastClosedSession: null })
        setViewportMock.mockResolvedValue({ applied: { width: 1000, height: 700 } })
        const { result } = renderHook(() => useBrowserSessionForThread('thread-1', 'agent-1', { surface: 'agent' }), { wrapper: makeWrapper() })
        await waitFor(() => expect(result.current.query.data?.session).toBeNull())
        act(() => { result.current.reportViewport({ width: 900.4, height: 700 }) })
        await act(async () => { await result.current.ensureMutation.mutateAsync() })
        expect(ensureSessionMock).toHaveBeenCalledWith('tenant-1', 'thread-1', 'agent-1', 'agent', { width: 900, height: 700 })
        await waitFor(() => expect(result.current.query.data?.session?.id).toBe('mock-session-id'))
        // The session appeared: the pane's size is sent to it, once the debounce settles.
        await act(async () => { await vi.advanceTimersByTimeAsync(VIEWPORT_SEND_DEBOUNCE_MS + 10) })
        expect(setViewportMock).toHaveBeenCalledTimes(1)
        expect(setViewportMock).toHaveBeenCalledWith('tenant-1', 'thread-1', 'mock-session-id', { width: 900, height: 700 }, 'agent')
        // A drag: many reports, one send, after the last one.
        act(() => { result.current.reportViewport({ width: 950, height: 700 }) })
        act(() => { result.current.reportViewport({ width: 980, height: 700 }) })
        act(() => { result.current.reportViewport({ width: 1000, height: 700 }) })
        act(() => { result.current.onResizeEnd() })
        await act(async () => { await vi.advanceTimersByTimeAsync(VIEWPORT_SEND_DEBOUNCE_MS + 10) })
        expect(setViewportMock).toHaveBeenCalledTimes(2)
        expect(setViewportMock).toHaveBeenLastCalledWith('tenant-1', 'thread-1', 'mock-session-id', { width: 1000, height: 700 }, 'agent')
        // The same size again sends nothing.
        act(() => { result.current.reportViewport({ width: 1000, height: 700 }) })
        act(() => { result.current.onResizeEnd() })
        await act(async () => { await vi.advanceTimersByTimeAsync(VIEWPORT_SEND_DEBOUNCE_MS + 10) })
        expect(setViewportMock).toHaveBeenCalledTimes(2)
      } finally {
        vi.useRealTimers()
      }
    })
  })


  describe('pausedFrameUrl derivation', () => {
    // The hook's job: expose pausedFrameUrl ONLY when (no live session) AND
    // (last closed session ended idle_timeout) AND (cached frame present).
    // Anything else → null. The component renders based on this gate, so a
    // false positive here would show a stale frame for a manually-ended
    // session (bad UX); a false negative would skip the paused-frame UX
    // when it's available (regression to the catch-all error).

    it('is null when there is a live session (active wins)', async () => {
      getActiveSessionMock.mockResolvedValue({
        session: session(),
        lastClosedSession: session({
          closedAt: 'now', closedReason: 'idle_timeout',
          lastScreenshotSignedUrl: 'https://signed/frame.png',
        }),
      })
      const { result } = renderHook(
        () => useBrowserSessionForThread('thread-1', 'agent-1'),
        { wrapper: makeWrapper() },
      )
      await waitFor(() => expect(result.current.query.data?.session).not.toBeNull())
      expect(result.current.pausedFrameUrl).toBeNull()
    })

    it('is null when the last closed session did NOT end via idle_timeout', async () => {
      // user_ended / completed / failed all suppress — the user knows they
      // ended it; showing the freeze frame would be confusing.
      getActiveSessionMock.mockResolvedValue({
        session: null,
        lastClosedSession: session({
          closedAt: 'now', closedReason: 'user_ended',
          lastScreenshotSignedUrl: 'https://signed/frame.png',
        }),
      })
      const { result } = renderHook(
        () => useBrowserSessionForThread('thread-1', 'agent-1'),
        { wrapper: makeWrapper() },
      )
      await waitFor(() => expect(result.current.query.isSuccess).toBe(true))
      expect(result.current.pausedFrameUrl).toBeNull()
    })

    it('is null when the last closed session has no cached screenshot URL', async () => {
      getActiveSessionMock.mockResolvedValue({
        session: null,
        lastClosedSession: session({
          closedAt: 'now', closedReason: 'idle_timeout',
          lastScreenshotSignedUrl: '', // backend omits → empty string
        }),
      })
      const { result } = renderHook(
        () => useBrowserSessionForThread('thread-1', 'agent-1'),
        { wrapper: makeWrapper() },
      )
      await waitFor(() => expect(result.current.query.isSuccess).toBe(true))
      expect(result.current.pausedFrameUrl).toBeNull()
    })

    it('is set when all three preconditions are satisfied', async () => {
      getActiveSessionMock.mockResolvedValue({
        session: null,
        lastClosedSession: session({
          closedAt: 'now', closedReason: 'idle_timeout',
          lastScreenshotSignedUrl: 'https://signed/frame.png',
        }),
      })
      const { result } = renderHook(
        () => useBrowserSessionForThread('thread-1', 'agent-1'),
        { wrapper: makeWrapper() },
      )
      await waitFor(() => expect(result.current.pausedFrameUrl)
        .toBe('https://signed/frame.png'))
    })
  })

  describe('isEnsureError (single boolean, collapsed from typed envelope)', () => {
    // Per-kind copy was scope creep; the user explicitly does NOT want
    // different vendor-failure messages. The hook now collapses both the
    // typed envelope (HTTP 200 + structured failure) AND the unclassified
    // rejection (HTTP 5xx) into one boolean. The backend keeps the typed
    // kind on the wire for logs/metrics — the frontend just sees "failed".

    it('is true when the response carries a typed error envelope', async () => {
      getActiveSessionMock.mockResolvedValue({ session: null, lastClosedSession: null })
      ensureSessionMock.mockResolvedValue({
        session: null, wasNewlyCreated: false,
        error: { kind: 'quota_exceeded', message: 'Anchor 402: out of credits' },
        lastClosedSession: null,
      })
      const { result } = renderHook(
        () => useBrowserSessionForThread('thread-1', 'agent-1'),
        { wrapper: makeWrapper() },
      )
      await waitFor(() => expect(result.current.query.isSuccess).toBe(true))
      await act(async () => { await result.current.ensureMutation.mutateAsync() })
      await waitFor(() => expect(result.current.isEnsureError).toBe(true))
    })

    it('is true when the mutation rejected outright (unclassified 5xx)', async () => {
      getActiveSessionMock.mockResolvedValue({ session: null, lastClosedSession: null })
      ensureSessionMock.mockRejectedValue(new Error('500'))
      const { result } = renderHook(
        () => useBrowserSessionForThread('thread-1', 'agent-1'),
        { wrapper: makeWrapper() },
      )
      await waitFor(() => expect(result.current.query.isSuccess).toBe(true))
      await act(async () => {
        try { await result.current.ensureMutation.mutateAsync() } catch { /* expected */ }
      })
      await waitFor(() => expect(result.current.isEnsureError).toBe(true))
    })

    it('is false when the mutation succeeded', async () => {
      getActiveSessionMock.mockResolvedValue({ session: null, lastClosedSession: null })
      ensureSessionMock.mockResolvedValue({
        session: session(), wasNewlyCreated: true,
        error: null, lastClosedSession: null,
      })
      const { result } = renderHook(
        () => useBrowserSessionForThread('thread-1', 'agent-1'),
        { wrapper: makeWrapper() },
      )
      await waitFor(() => expect(result.current.query.isSuccess).toBe(true))
      await act(async () => { await result.current.ensureMutation.mutateAsync() })
      expect(result.current.isEnsureError).toBe(false)
    })

    it('propagates lastClosedSession from the ensure success-with-error response into the active cache', async () => {
      // Critical for the "ensure fails AND prior session was idle-reaped"
      // case: the paused-frame UX has to keep working even though ensure
      // didn't produce a live session. The hook's onSuccess cache mirror
      // writes both fields. (Kind on the envelope doesn't matter for the UI
      // — only the lastClosedSession ride-along does.)
      getActiveSessionMock.mockResolvedValue({ session: null, lastClosedSession: null })
      ensureSessionMock.mockResolvedValue({
        session: null, wasNewlyCreated: false,
        error: { kind: 'anchor_unavailable', message: 'x' },
        lastClosedSession: session({
          closedAt: 'now', closedReason: 'idle_timeout',
          lastScreenshotSignedUrl: 'https://signed/frame.png',
        }),
      })
      const { result } = renderHook(
        () => useBrowserSessionForThread('thread-1', 'agent-1'),
        { wrapper: makeWrapper() },
      )
      await waitFor(() => expect(result.current.query.isSuccess).toBe(true))
      await act(async () => { await result.current.ensureMutation.mutateAsync() })
      await waitFor(() => expect(result.current.pausedFrameUrl)
        .toBe('https://signed/frame.png'))
    })
  })
})

describe('the session event stream', () => {
  // The surface travels with the stream as it does with every other call for
  // the thread: the backend picks the thread's table from it. Without it an
  // assistant's thread was looked up on agent chat and the stream 404'd, and
  // the pane ran on the refetch backstop alone.
  it("names the thread's surface so an assistant's thread is found", async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise(() => {}) as Promise<Response>,
    )
    getActiveSessionMock.mockResolvedValue({ session: null, lastClosedSession: null })
    renderHook(
      () => useBrowserSessionForThread('thread-1', null, { surface: 'liftoff' }),
      { wrapper: makeWrapper() },
    )
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    const url = String(fetchSpy.mock.calls[0][0])
    expect(url).toContain('/api/threads/thread-1/browser-sessions/stream?')
    expect(url).toContain('tenantId=tenant-1')
    expect(url).toContain('surface=liftoff')
    fetchSpy.mockRestore()
  })

  it('defaults to agent chat', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(
      () => new Promise(() => {}) as Promise<Response>,
    )
    getActiveSessionMock.mockResolvedValue({ session: null, lastClosedSession: null })
    renderHook(
      () => useBrowserSessionForThread('thread-1', 'agent-1'),
      { wrapper: makeWrapper() },
    )
    await waitFor(() => expect(fetchSpy).toHaveBeenCalled())
    expect(String(fetchSpy.mock.calls[0][0])).toContain('surface=agent')
    fetchSpy.mockRestore()
  })
})
