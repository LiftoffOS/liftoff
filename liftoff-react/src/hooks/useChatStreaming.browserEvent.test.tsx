import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { useChatStreaming } from './useChatStreaming'

// The person's browser events as turns: a hand-back with the button starts a
// turn with no words of theirs (no person bubble, a status row in their name
// while it runs); a send while driving carries the hand-back beside the words
// in ONE turn; a point does the same with its own row; a 409 from the backend
// (the hold is no longer pending) is quiet: no toast, and the composer stays as
// it was.

const showToast = vi.fn()
vi.mock('./useTenant', () => ({
  useTenant: () => ({ currentTenant: { id: 'tenant-1' } }),
}))
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast }),
}))

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

const HOLD = '11111111-1111-4111-8111-111111111111'

type StreamMessage = Parameters<typeof useChatStreaming>[0]['streamMessage']

function hook(
  streamMessage: ReturnType<typeof vi.fn>,
  currentThreadId: string | null = 'thread-1',
  viewerDisplayName: string | null = 'Ada Lovelace',
) {
  return renderHook(
    () =>
      useChatStreaming({
        streamMessage: streamMessage as unknown as StreamMessage,
        createThreadMutation: { mutateAsync: vi.fn(), isPending: false },
        messagesQueryKeyPrefix: ['msgs'],
        threadsQueryKeyPrefix: ['threads'],
        currentThreadId,
        setCurrentThreadId: vi.fn(),
        viewerDisplayName,
      }),
    { wrapper },
  )
}


describe("useChatStreaming — the person's browser events", () => {
  beforeEach(() => vi.clearAllMocks())

  it('sendBrowserHandback starts a turn with no words: the hold on the wire, no content, no person bubble, a status row in their name', async () => {
    let seen: Record<string, unknown> | null = null
    const streamMessage = vi.fn().mockImplementation(async (input, callbacks) => {
      seen = input
      callbacks.onTextDelta?.('Picking up where you left the browser.')
      await new Promise(() => {})
    })
    const { result } = hook(streamMessage)
    act(() => { void result.current.sendBrowserHandback(HOLD) })
    await waitFor(() => expect(result.current.streaming).not.toBeNull())
    expect(seen).toEqual({ tenantId: 'tenant-1', threadId: 'thread-1', browserHandback: { holdId: HOLD } })
    expect(result.current.streaming?.userMessage).toBe('')
    expect(result.current.streaming?.browserEvent).toEqual({ kind: 'handback', text: 'Ada Lovelace handed the browser back' })
    expect(result.current.streaming?.assistantText).toBe('Picking up where you left the browser.')
  })

  it('a null hold sends nothing', async () => {
    const streamMessage = vi.fn()
    const { result } = hook(streamMessage)
    await act(async () => { await result.current.sendBrowserHandback(null) })
    expect(streamMessage).not.toHaveBeenCalled()
    expect(result.current.streaming).toBeNull()
  })

  it('an event alone needs a thread: it cannot open one', async () => {
    const streamMessage = vi.fn()
    const { result } = hook(streamMessage, null)
    await act(async () => { await result.current.sendBrowserHandback(HOLD) })
    expect(streamMessage).not.toHaveBeenCalled()
  })

  it('an event needs the person\'s name for its row: before the account has loaded nothing is sent', async () => {
    const streamMessage = vi.fn()
    const { result } = hook(streamMessage, 'thread-1', null)
    await act(async () => { await result.current.sendBrowserHandback(HOLD) })
    expect(streamMessage).not.toHaveBeenCalled()
  })

  it('a send while driving carries the hand-back beside the words, in one turn', async () => {
    let seen: Record<string, unknown> | null = null
    const streamMessage = vi.fn().mockImplementation(async (input, callbacks) => {
      seen = input
      callbacks.onComplete?.({ id: 'm1' })
    })
    const { result } = hook(streamMessage)
    act(() => { result.current.setInputValue('now summarise it') })
    await act(async () => {
      await result.current.handleSend(undefined, undefined, { browserHandback: { holdId: HOLD } })
    })
    expect(streamMessage).toHaveBeenCalledTimes(1)
    expect(seen).toMatchObject({ threadId: 'thread-1', content: 'now summarise it', browserHandback: { holdId: HOLD } })
  })



  it('a 409 on an event turn is quiet: no toast, the scaffold goes, and the composer stays as it was', async () => {
    const streamMessage = vi.fn().mockImplementation(async (_input, callbacks) => {
      callbacks.onError?.({ code: 'HTTP_409', message: 'handback_not_pending', status: 409 })
    })
    const { result } = hook(streamMessage)
    act(() => { result.current.setInputValue('a draft I was typing') })
    await act(async () => { await result.current.sendBrowserHandback(HOLD) })
    await waitFor(() => expect(result.current.streaming).toBeNull())
    expect(showToast).not.toHaveBeenCalled()
    // The event turn cleared nothing the person typed: the composer keeps its draft.
    expect(result.current.inputValue).toBe('a draft I was typing')
  })

  it('any other failure on an event turn is reported as a send failure is', async () => {
    const streamMessage = vi.fn().mockImplementation(async (_input, callbacks) => {
      callbacks.onError?.({ code: 'HTTP_500', message: 'Something went wrong.', status: 500 })
    })
    const { result } = hook(streamMessage)
    await act(async () => { await result.current.sendBrowserHandback(HOLD) })
    await waitFor(() => expect(result.current.streaming).toBeNull())
    expect(showToast).toHaveBeenCalled()
  })
})
