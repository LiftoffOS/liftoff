import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import type { ReactNode } from 'react'
import { useChatStreaming } from './useChatStreaming'

// A billing refusal is the one streaming error with a remedy, and the gate is
// where that remedy is offered. Reported through the generic toast chain it
// reaches the person as "Something went wrong" with nothing to act on — and
// chat is where a workspace paying by the dollar runs out, because chat is
// where the work happens.

const mocks = vi.hoisted(() => ({
  showToast: vi.fn(),
  openIfPaymentRequired: vi.fn(),
}))

vi.mock('./useTenant', () => ({
  useTenant: () => ({ currentTenant: { id: 'tenant-1' } }),
}))
vi.mock('../contexts/ToastContext', () => ({
  useToast: () => ({ showToast: mocks.showToast }),
}))
vi.mock('../components/Dashboard/planGateContext', () => ({
  usePlanGate: () => ({ openIfPaymentRequired: mocks.openIfPaymentRequired }),
}))

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>
}

function renderWithStreamError(err: { code: string; message: string; status?: number }) {
  const streamMessage = vi.fn().mockImplementation(async (_input, callbacks) => {
    callbacks.onError?.(err)
  })

  return renderHook(
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
}

async function send(result: { current: { setInputValue: (v: string) => void; handleSend: () => Promise<unknown> } }) {
  act(() => {
    result.current.setInputValue('summarise Q2')
  })
  await act(async () => {
    await result.current.handleSend()
  })
}

describe('useChatStreaming — a billing refusal mid-chat', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.openIfPaymentRequired.mockReturnValue(true)
  })

  it('opens the gate on a 402 and says nothing else', async () => {
    const { result } = renderWithStreamError({
      code: 'HTTP_ERROR',
      message: 'Your credit balance is $0. Please add credit to continue.',
      status: 402,
    })

    await send(result)

    await waitFor(() => expect(mocks.openIfPaymentRequired).toHaveBeenCalled())
    // The gate reported it, so the toast chain must not report it again.
    expect(mocks.showToast).not.toHaveBeenCalled()
  })

  // StreamError is a plain shape, not an ApiError, and the gate matches on
  // `instanceof ApiError`. Passing the raw error straight through would match
  // nothing and the gate would never open.
  it('hands the gate an error it can actually recognise', async () => {
    const { result } = renderWithStreamError({
      code: 'HTTP_ERROR',
      message: 'Your credit balance is $0. Please add credit to continue.',
      status: 402,
    })

    await send(result)

    await waitFor(() => expect(mocks.openIfPaymentRequired).toHaveBeenCalled())
    const passed = mocks.openIfPaymentRequired.mock.calls[0][0] as Error & { status?: number }
    expect(passed).toBeInstanceOf(Error)
    expect(passed.status).toBe(402)
    expect(passed.message).toContain('credit balance')
  })

  // Outside the dashboard there is no provider, and usePlanGate answers false
  // by design. The person must still be told something.
  it('falls through to the toast when no gate is mounted', async () => {
    mocks.openIfPaymentRequired.mockReturnValue(false)

    const { result } = renderWithStreamError({
      code: 'HTTP_ERROR',
      message: 'Your credit balance is $0. Please add credit to continue.',
      status: 402,
    })

    await send(result)

    await waitFor(() => expect(mocks.showToast).toHaveBeenCalled())
  })

  it('leaves every other failure to the toast chain', async () => {
    const { result } = renderWithStreamError({
      code: 'HTTP_ERROR',
      message: 'boom',
      status: 500,
    })

    await send(result)

    await waitFor(() => expect(mocks.showToast).toHaveBeenCalled())
    expect(mocks.openIfPaymentRequired).not.toHaveBeenCalled()
  })
})
