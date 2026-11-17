import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { useChatStreaming } from './useChatStreaming'

// Attribution on hand-over, owned by the hook for every surface.
//
// A colleague brought into the reply mid-turn goes on the live bubble as a
// chip the moment the `delegation_started` frame arrives, and the activity
// line names it. Two hand-overs are two chips; the same one twice is one. The
// line moves on when the reply's own text or a tool call shows what is
// happening; the chips stay until the stream ends, when the persisted reply
// carries its own copy.

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

type Callbacks = Record<string, ((...a: unknown[]) => void) | undefined>

/** Start a turn whose stream stays open, and hand back its callbacks. */
async function startTurn() {
  let callbacks: Callbacks = {}
  const streamMessage = vi.fn().mockImplementationOnce(async (_input, cb) => {
    callbacks = cb
    cb.onThinking?.()
    await new Promise(() => {}) // never settles: the run is still going
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

  act(() => {
    result.current.setInputValue('review this')
  })
  act(() => {
    void result.current.handleSend()
  })
  await waitFor(() => expect(result.current.streaming).not.toBeNull())
  return { result, callbacks: () => callbacks }
}

const SECURITY = { id: 'agent-7', label: 'Security Review' }
const LEGAL = { id: 'agent-8', label: 'Legal Counsel' }

describe('useChatStreaming — hand-over attribution', () => {
  beforeEach(() => vi.clearAllMocks())

  it('puts the colleague on the live bubble and names it on the activity line', async () => {
    const { result, callbacks } = await startTurn()

    act(() => {
      callbacks().onDelegationStarted?.(SECURITY)
    })

    expect(result.current.streaming?.contributors).toEqual([SECURITY])
    expect(result.current.streaming?.activityOverride).toBe('Working with Security Review')
    expect(result.current.streaming?.thinking).toBe(false)
    expect(result.current.streaming?.currentTool).toBeNull()
  })

  it('keeps one chip per colleague across two hand-overs, and one for the same colleague twice', async () => {
    const { result, callbacks } = await startTurn()

    act(() => {
      callbacks().onDelegationStarted?.(SECURITY)
      callbacks().onTextDelta?.('Security says it is fine. ')
      callbacks().onDelegationStarted?.(LEGAL)
      callbacks().onDelegationStarted?.(SECURITY)
    })

    expect(result.current.streaming?.contributors).toEqual([SECURITY, LEGAL])
    expect(result.current.streaming?.activityOverride).toBe('Working with Security Review')
  })

  it('ends the hand-over line when the reply itself resumes, and keeps the chip', async () => {
    const { result, callbacks } = await startTurn()

    act(() => {
      callbacks().onDelegationStarted?.(SECURITY)
      callbacks().onTextDelta?.('Reviewed.')
    })

    expect(result.current.streaming?.activityOverride).toBeNull()
    expect(result.current.streaming?.contributors).toEqual([SECURITY])
  })

  // On Liftoff the colleague's own tool calls are relayed on the same stream,
  // and "Working with X" masking "Reading connectors" would hide what the
  // colleague is doing.
  it('ends the hand-over line when a tool call shows what is happening, and keeps the chip', async () => {
    const { result, callbacks } = await startTurn()

    act(() => {
      callbacks().onDelegationStarted?.(SECURITY)
      callbacks().onToolCall?.('web_search')
    })

    expect(result.current.streaming?.activityOverride).toBeNull()
    expect(result.current.streaming?.currentTool).toBe('web_search')
    expect(result.current.streaming?.contributors).toEqual([SECURITY])
  })

  it('starts every turn with nobody else on it', async () => {
    const { result } = await startTurn()

    expect(result.current.streaming?.contributors).toBeUndefined()
    expect(result.current.streaming?.activityOverride).toBeUndefined()
  })
})
