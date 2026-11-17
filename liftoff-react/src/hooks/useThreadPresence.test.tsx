import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'

const heartbeatMock = vi.fn()
const clearPresenceMock = vi.fn()
vi.mock('./useTenant', () => ({ useTenant: () => ({ currentTenant: { id: 'tenant-1' } }) }))

import { useThreadPresence } from './useThreadPresence'
import type { ChatPresenceTransport } from '../services/presence'

// A stand-in for whichever surface is being viewed. The hook only ever calls
// through the transport, which is the point: agent chat and the Chief AI
// Officer chat share this hook and differ only in the object passed here.
const transport: ChatPresenceTransport = {
  key: 'test-surface',
  heartbeat: (...a: unknown[]) => heartbeatMock(...a),
  clear: (...a: unknown[]) => clearPresenceMock(...a),
  turnEvents: vi.fn(),
  messagesQueryKey: (tenantId: string, threadId: string) => ['messages', tenantId, threadId],
} as unknown as ChatPresenceTransport

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

const EMPTY = { viewers: [], latestMessageAt: null }

beforeEach(() => {
  vi.clearAllMocks()
  heartbeatMock.mockResolvedValue(EMPTY)
  clearPresenceMock.mockResolvedValue(undefined)
})

afterEach(() => {
  vi.useRealTimers()
})

describe('useThreadPresence', () => {
  it('does not poll until the surface and thread are both known', () => {
    renderHook(() => useThreadPresence(null, null, { draft: '', isStreaming: false }), {
      wrapper: makeWrapper(),
    })
    expect(heartbeatMock).not.toHaveBeenCalled()
  })

  it('heartbeats as viewing when the composer is empty', async () => {
    renderHook(() => useThreadPresence(transport, 'thread-1', { draft: '', isStreaming: false }), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => expect(heartbeatMock).toHaveBeenCalled())
    expect(heartbeatMock).toHaveBeenCalledWith('tenant-1', 'thread-1', 'viewing')
  })

  it('reports typing once the draft changes, and stops after a quiet spell', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { result, rerender } = renderHook(
      ({ draft }) => useThreadPresence(transport, 'thread-1', { draft, isStreaming: false }),
      { wrapper: makeWrapper(), initialProps: { draft: '' } },
    )

    rerender({ draft: 'hello' })
    expect(result.current.isTyping).toBe(true)

    // Quiet for longer than the idle window: no longer typing.
    await act(async () => { vi.advanceTimersByTime(5000) })
    expect(result.current.isTyping).toBe(false)
  })

  it('treats an emptied composer as not typing (covers the clear on send)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { result, rerender } = renderHook(
      ({ draft }) => useThreadPresence(transport, 'thread-1', { draft, isStreaming: false }),
      { wrapper: makeWrapper(), initialProps: { draft: '' } },
    )

    rerender({ draft: 'hello' })
    expect(result.current.isTyping).toBe(true)
    // handleSend clears the composer; that must not read as a keystroke.
    rerender({ draft: '' })
    expect(result.current.isTyping).toBe(false)
  })

  it('surfaces the roster from the poll', async () => {
    heartbeatMock.mockResolvedValue({
      viewers: [{
        accountId: 'acc-2', firstName: 'Ada', lastName: 'Lovelace',
        email: 'ada@example.com', avatarUrl: null, typing: true,
      }],
      latestMessageAt: null,
    })
    const { result } = renderHook(
      () => useThreadPresence(transport, 'thread-1', { draft: '', isStreaming: false }),
      { wrapper: makeWrapper() },
    )
    await waitFor(() => expect(result.current.viewers).toHaveLength(1))
    expect(result.current.viewers[0].typing).toBe(true)
  })

  it('a viewer who is not driving releases the seat and stops polling when the tab is hidden', async () => {
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    renderHook(() => useThreadPresence(transport, 'thread-1', { draft: '', isStreaming: false }), {
      wrapper: makeWrapper(),
    })
    await waitFor(() => expect(heartbeatMock).toHaveBeenCalled())
    hidden.mockReturnValue(true)
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    await waitFor(() => expect(clearPresenceMock).toHaveBeenCalledWith('tenant-1', 'thread-1'))
    hidden.mockRestore()
  })

  it('a driver keeps the seat while the tab is hidden and while the browser believes it is offline', async () => {
    // A driver must not lose the wheel without leaving the tab. The seat is what the stale-driver sweep reads,
    // so while they drive it is never released on hidden, the heartbeat keeps
    // polling in the background, and an offline flag does not pause it.
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const hidden = vi.spyOn(document, 'hidden', 'get').mockReturnValue(false)
    const { onlineManager } = await import('@tanstack/react-query')
    renderHook(
      () => useThreadPresence(transport, 'thread-1', { draft: '', isStreaming: false, holdSeat: true }),
      { wrapper: makeWrapper() },
    )
    await waitFor(() => expect(heartbeatMock).toHaveBeenCalled())
    hidden.mockReturnValue(true)
    act(() => { document.dispatchEvent(new Event('visibilitychange')) })
    act(() => { onlineManager.setOnline(false) })
    const before = heartbeatMock.mock.calls.length
    await act(async () => { await vi.advanceTimersByTimeAsync(3500) })
    expect(heartbeatMock.mock.calls.length).toBeGreaterThan(before)
    expect(clearPresenceMock).not.toHaveBeenCalled()
    act(() => { onlineManager.setOnline(true) })
    hidden.mockRestore()
  })

  it('releases the seat when the thread is left', async () => {
    const { unmount } = renderHook(
      () => useThreadPresence(transport, 'thread-1', { draft: '', isStreaming: false }),
      { wrapper: makeWrapper() },
    )
    await waitFor(() => expect(heartbeatMock).toHaveBeenCalled())
    unmount()
    expect(clearPresenceMock).toHaveBeenCalledWith('tenant-1', 'thread-1')
  })
})
