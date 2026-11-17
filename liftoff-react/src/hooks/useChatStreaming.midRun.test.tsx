import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { useChatStreaming } from './useChatStreaming'

// Reproduction probe for the interaction between two things that shipped at
// different times:
//   - sendDuringRun's onInterruptDelivered refetches the message list on
//     purpose, so the mid-run message shows under the live reply.
//   - the scaffold-clear effect predates mid-run sending and clears `streaming`
//     for ANY persisted user message dated after the turn started.
// If both hold, delivering a mid-run message tears down the live bubble.

vi.mock('./useTenant', () => ({
  useTenant: () => ({ currentTenant: { id: 'tenant-1' } }),
}))
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: vi.fn() }),
}))

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

describe('useChatStreaming — mid-run message vs the live bubble', () => {
  beforeEach(() => vi.clearAllMocks())

  it('keeps the live reply on screen when a mid-run message is delivered', async () => {
    // The first turn: opens, emits some text, and stays open (never resolves)
    // so `streaming` remains set — exactly like a real run still in flight.
    let firstTurnCallbacks: Record<string, ((...a: unknown[]) => void)> = {}
    const streamMessage = vi
      .fn()
      // call 1 — the turn the person is watching
      .mockImplementationOnce(async (_input, callbacks) => {
        firstTurnCallbacks = callbacks
        callbacks.onTextDelta?.('Working on it')
        await new Promise(() => {}) // never settles: the run is still going
      })
      // call 2 — the mid-run message, acked as an interrupt
      .mockImplementationOnce(async (_input, callbacks) => {
        callbacks.onInterruptDelivered?.()
      })

    const { result } = renderHook(
      () =>
        useChatStreaming({
          streamMessage,
          createThreadMutation: { mutateAsync: vi.fn(), isPending: false },
          messagesQueryKeyPrefix: ['msgs'],
          threadsQueryKeyPrefix: ['threads'],
          currentThreadId: 'thread-1',
          setCurrentThreadId: vi.fn(),
        }),
      { wrapper },
    )

    // Start the turn.
    act(() => {
      result.current.setInputValue('summarise Q2')
    })
    act(() => {
      void result.current.handleSend()
    })
    await waitFor(() => expect(result.current.streaming).not.toBeNull())
    expect(result.current.streaming?.assistantText).toBe('Working on it')

    // Person types during the run and sends. The message is delivered as an
    // interrupt to the running turn, and onInterruptDelivered refetches the
    // thread so the mid-run message appears under the live reply.
    act(() => {
      result.current.setInputValue('actually use Q3')
    })
    await act(async () => {
      await result.current.sendDuringRun()
    })

    // The turn is still running and has said nothing new. The live reply must
    // still be on screen.
    expect(result.current.streaming).not.toBeNull()
    expect(result.current.streaming?.assistantText).toBe('Working on it')

    // And it must still accept deltas from the original stream.
    act(() => {
      firstTurnCallbacks.onTextDelta?.(', using Q3')
    })
    expect(result.current.streaming?.assistantText).toContain('using Q3')
  })
})
