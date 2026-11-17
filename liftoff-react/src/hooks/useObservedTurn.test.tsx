import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'

const getTurnEventsMock = vi.fn()
vi.mock('./useTenant', () => ({ useTenant: () => ({ currentTenant: { id: 'tenant-1' } }) }))

import { useObservedTurn } from './useObservedTurn'
import type { ChatPresenceTransport } from '../services/presence'

// Stands in for whichever surface the turn is running on. The hook reaches the
// backend only through this, so agent chat and the Chief AI Officer chat share
// one implementation and differ only in the object passed here.
const transport: ChatPresenceTransport = {
  key: 'test-surface',
  heartbeat: vi.fn(),
  clear: vi.fn(),
  turnEvents: (...a: unknown[]) => getTurnEventsMock(...a),
  messagesQueryKey: (tenantId: string, threadId: string) => ['messages', tenantId, threadId],
} as unknown as ChatPresenceTransport

// Liftoff and the Insights Manager: same presence contract, but their routers
// record no per-turn execution events, so they declare no `turnEvents` at all.
const transportWithoutTurnEvents: ChatPresenceTransport = {
  key: 'no-turn-events-surface',
  heartbeat: vi.fn(),
  clear: vi.fn(),
  messagesQueryKey: (tenantId: string, threadId: string) => ['messages', tenantId, threadId],
} as unknown as ChatPresenceTransport

function wrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
}

const ev = (seq: number, kind: string, payload: Record<string, unknown> | null = null) =>
  ({ seq, kind, payload })

beforeEach(() => {
  vi.clearAllMocks()
  getTurnEventsMock.mockResolvedValue({ turnId: 't1', events: [], done: false })
})

afterEach(() => { vi.useRealTimers() })

describe('useObservedTurn', () => {
  // The sender already has the real stream; following their own turn would
  // double-render it.
  it('does not follow your own turn', () => {
    renderHook(() => useObservedTurn(transport, 'thread-1', 'turn-1', true), { wrapper: wrapper() })
    expect(getTurnEventsMock).not.toHaveBeenCalled()
  })

  it('does not poll when no turn is live', () => {
    renderHook(() => useObservedTurn(transport, 'thread-1', null, false), { wrapper: wrapper() })
    expect(getTurnEventsMock).not.toHaveBeenCalled()
  })

  it('rebuilds the assistant text by concatenating chunks in order', async () => {
    getTurnEventsMock.mockResolvedValueOnce({
      turnId: 'turn-1',
      events: [ev(1, 'text', { text: 'The payroll ' }), ev(2, 'text', { text: 'run is ready' })],
      done: false,
    })
    const { result } = renderHook(
      () => useObservedTurn(transport, 'thread-1', 'turn-1', false), { wrapper: wrapper() },
    )
    await waitFor(() => expect(result.current?.assistantText).toBe('The payroll run is ready'))
  })

  it('surfaces tool activity so the thread does not look frozen', async () => {
    getTurnEventsMock.mockResolvedValueOnce({
      turnId: 'turn-1', events: [ev(1, 'tool_call', { tool: 'web_search' })], done: false,
    })
    const { result } = renderHook(
      () => useObservedTurn(transport, 'thread-1', 'turn-1', false), { wrapper: wrapper() },
    )
    await waitFor(() => expect(result.current?.currentTool).toBe('web_search'))
  })

  // A follower attributes the live reply exactly as the sender does: the chip
  // for each colleague brought in, and "Working with <name>" until the next
  // text or tool call, read through the same parser off the same payload.
  it('surfaces a hand-over as a chip and a named activity line', async () => {
    getTurnEventsMock.mockResolvedValueOnce({
      turnId: 'turn-1',
      events: [
        ev(1, 'delegation_started', { author: 'agent-7', authorLabel: 'Security Review' }),
        ev(2, 'delegation_started', { author: 'agent-8', authorLabel: 'Legal Counsel' }),
        ev(3, 'delegation_started', { author: 'agent-7', authorLabel: 'Security Review' }),
      ],
      done: false,
    })
    const { result } = renderHook(
      () => useObservedTurn(transport, 'thread-1', 'turn-1', false), { wrapper: wrapper() },
    )
    await waitFor(() => expect(result.current?.contributors).toEqual([
      { id: 'agent-7', label: 'Security Review' },
      { id: 'agent-8', label: 'Legal Counsel' },
    ]))
    // The line names the latest hand-over; the third frame is Security Review
    // again, which adds no chip but is the colleague now at work.
    expect(result.current?.activityOverride).toBe('Working with Security Review')
    expect(result.current?.thinking).toBe(false)
  })

  it('ends the hand-over line on the next text or tool call, and keeps the chips', async () => {
    getTurnEventsMock.mockResolvedValueOnce({
      turnId: 'turn-1',
      events: [
        ev(1, 'delegation_started', { author: 'agent-7', authorLabel: 'Security Review' }),
        ev(2, 'tool_call', { tool: 'web_search' }),
      ],
      done: false,
    })
    const { result } = renderHook(
      () => useObservedTurn(transport, 'thread-1', 'turn-1', false), { wrapper: wrapper() },
    )
    await waitFor(() => expect(result.current?.currentTool).toBe('web_search'))
    expect(result.current?.activityOverride).toBeNull()
    expect(result.current?.contributors).toEqual([{ id: 'agent-7', label: 'Security Review' }])
  })

  it('ignores a hand-over that names nobody', async () => {
    getTurnEventsMock.mockResolvedValueOnce({
      turnId: 'turn-1',
      events: [ev(1, 'delegation_started', { agentName: 'Security Review' }), ev(2, 'text', { text: 'hi' })],
      done: false,
    })
    const { result } = renderHook(
      () => useObservedTurn(transport, 'thread-1', 'turn-1', false), { wrapper: wrapper() },
    )
    await waitFor(() => expect(result.current?.assistantText).toBe('hi'))
    expect(result.current?.contributors).toEqual([])
    expect(result.current?.activityOverride).toBeNull()
  })

  it('advances the cursor so each poll asks only for what it has not seen', async () => {
    getTurnEventsMock.mockResolvedValueOnce({
      turnId: 'turn-1', events: [ev(1, 'text', { text: 'a' }), ev(7, 'text', { text: 'b' })], done: false,
    })
    renderHook(() => useObservedTurn(transport, 'thread-1', 'turn-1', false), { wrapper: wrapper() })

    await waitFor(() => expect(getTurnEventsMock).toHaveBeenCalledTimes(1))
    expect(getTurnEventsMock).toHaveBeenNthCalledWith(1, 'tenant-1', 'thread-1', 'turn-1', 0)
    await waitFor(
      () => expect(getTurnEventsMock).toHaveBeenNthCalledWith(2, 'tenant-1', 'thread-1', 'turn-1', 7),
      { timeout: 3000 },
    )
  })

  // Once the turn is done the persisted message is the authority, so the
  // observed copy must get out of the way rather than sit alongside it.
  it('stops rendering once the turn finishes', async () => {
    getTurnEventsMock.mockResolvedValueOnce({
      turnId: 'turn-1', events: [ev(1, 'text', { text: 'all done' }), ev(2, 'done')], done: true,
    })
    const { result } = renderHook(
      () => useObservedTurn(transport, 'thread-1', 'turn-1', false), { wrapper: wrapper() },
    )
    await waitFor(() => expect(result.current).toBeNull())
  })

  it('does not carry one turn text into the next', async () => {
    getTurnEventsMock.mockResolvedValueOnce({
      turnId: 'turn-1', events: [ev(1, 'text', { text: 'first turn' })], done: false,
    })
    const { result, rerender } = renderHook(
      ({ turn }) => useObservedTurn(transport, 'thread-1', turn, false),
      { wrapper: wrapper(), initialProps: { turn: 'turn-1' as string | null } },
    )
    await waitFor(() => expect(result.current?.assistantText).toBe('first turn'))

    getTurnEventsMock.mockResolvedValue({
      turnId: 'turn-2', events: [ev(1, 'text', { text: 'second turn' })], done: false,
    })
    await act(async () => { rerender({ turn: 'turn-2' }) })
    await waitFor(() => expect(result.current?.assistantText).toBe('second turn'))
  })

  it('keeps quiet when following fails', async () => {
    getTurnEventsMock.mockRejectedValue(new Error('network'))
    const { result } = renderHook(
      () => useObservedTurn(transport, 'thread-1', 'turn-1', false), { wrapper: wrapper() },
    )
    await waitFor(() => expect(getTurnEventsMock).toHaveBeenCalled())
    expect(result.current?.assistantText).toBe('')
  })

  // A live turn on a surface that records no execution events. `liveTurnId` is
  // truthful there — a reply really is being generated — but it is an indicator
  // rather than a cursor, so there is nothing to replay.
  //
  // Returning null is the whole point of leaving `turnEvents` off the transport
  // instead of stubbing it: a stub resolving empty-and-done would leave the
  // follower enabled and render an empty bubble for as long as the other
  // person's turn ran.
  it('renders nothing on a surface that records no turn events', async () => {
    const { result } = renderHook(
      () => useObservedTurn(transportWithoutTurnEvents, 'thread-1', 'turn-1', false),
      { wrapper: wrapper() },
    )

    expect(result.current).toBeNull()
    // Nothing to poll, so nothing is polled: no request goes to a route this
    // surface does not serve.
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(getTurnEventsMock).not.toHaveBeenCalled()
    expect(result.current).toBeNull()
  })
})
