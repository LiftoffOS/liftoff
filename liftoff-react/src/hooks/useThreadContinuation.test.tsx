// Work that goes on after a reply, as the conversation reads it.
//
// The three properties a reader depends on: the conversation reads as still
// working while the queued work is queued or running; the transcript is
// refetched exactly once when that work ends, so its reply appears without a
// reload; and a live turn is never polled behind, because the person is
// already watching it and their message cancelled the queued work anyway.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import React from 'react'
import { useThreadContinuation } from './useThreadContinuation'

const liftoffRead = vi.fn()
const insightsRead = vi.fn()
vi.mock('../services/liftoffChat', () => ({
  getLiftoffThreadContinuation: (...a: unknown[]) => liftoffRead(...a),
}))
vi.mock('../services/insightsChat', () => ({
  getInsightsThreadContinuation: (...a: unknown[]) => insightsRead(...a),
}))

const TENANT = 'tenant-1'
const THREAD = 'thread-1'

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const wrapper = ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  )
  // Stands in for the next poll, which is otherwise twenty seconds away.
  const poll = () => qc.invalidateQueries({ queryKey: ['thread-continuation'] })
  return { wrapper, poll }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useThreadContinuation', () => {
  it('reads the surface it was given, and the conversation works while the work is queued or running', async () => {
    liftoffRead.mockResolvedValue({ status: 'queued' })
    const { result } = renderHook(
      () => useThreadContinuation('liftoff', { tenantId: TENANT, threadId: THREAD, isStreaming: false }),
      { wrapper: makeWrapper().wrapper },
    )
    await waitFor(() => expect(result.current.isWorking).toBe(true))
    expect(result.current.continuation).toEqual({ status: 'queued' })
    expect(liftoffRead).toHaveBeenCalledWith(TENANT, THREAD)
    expect(insightsRead).not.toHaveBeenCalled()
  })

  it('the Insights Manager reads its own router', async () => {
    insightsRead.mockResolvedValue({ status: 'running' })
    const { result } = renderHook(
      () => useThreadContinuation('insights', { tenantId: TENANT, threadId: THREAD, isStreaming: false }),
      { wrapper: makeWrapper().wrapper },
    )
    await waitFor(() => expect(result.current.isWorking).toBe(true))
    expect(insightsRead).toHaveBeenCalledWith(TENANT, THREAD)
    expect(liftoffRead).not.toHaveBeenCalled()
  })

  it('nothing queued reads as finished, and the transcript is not refetched for work that never ran', async () => {
    liftoffRead.mockResolvedValue(null)
    const onFinished = vi.fn()
    const { result } = renderHook(
      () => useThreadContinuation('liftoff', { tenantId: TENANT, threadId: THREAD, isStreaming: false, onFinished }),
      { wrapper: makeWrapper().wrapper },
    )
    await waitFor(() => expect(liftoffRead).toHaveBeenCalled())
    expect(result.current.isWorking).toBe(false)
    expect(onFinished).not.toHaveBeenCalled()
  })

  it('tells the caller once when the work ends, so the reply it wrote can be fetched', async () => {
    liftoffRead.mockResolvedValue({ status: 'running' })
    const onFinished = vi.fn()
    const { wrapper, poll } = makeWrapper()
    const { result } = renderHook(
      (props: { streaming: boolean }) => useThreadContinuation('liftoff', {
        tenantId: TENANT, threadId: THREAD, isStreaming: props.streaming, onFinished,
      }),
      { wrapper, initialProps: { streaming: false } },
    )
    await waitFor(() => expect(result.current.isWorking).toBe(true))
    expect(onFinished).not.toHaveBeenCalled()

    // The work finished: the next read says so.
    liftoffRead.mockResolvedValue(null)
    await poll()
    await waitFor(() => expect(result.current.isWorking).toBe(false))
    await waitFor(() => expect(onFinished).toHaveBeenCalledTimes(1))

    // Still nothing queued: told once, not on every read.
    const callsAfterFinish = liftoffRead.mock.calls.length
    await poll()
    await waitFor(() => expect(liftoffRead.mock.calls.length).toBeGreaterThan(callsAfterFinish))
    expect(onFinished).toHaveBeenCalledTimes(1)
  })

  it('a streaming turn is not polled, and starting one clears the answer at once: the message cancelled the queued work', async () => {
    liftoffRead.mockResolvedValue({ status: 'queued' })
    const { wrapper } = makeWrapper()
    const { result, rerender } = renderHook(
      (props: { streaming: boolean }) => useThreadContinuation('liftoff', {
        tenantId: TENANT, threadId: THREAD, isStreaming: props.streaming,
      }),
      { wrapper, initialProps: { streaming: false } },
    )
    await waitFor(() => expect(result.current.isWorking).toBe(true))
    const callsBefore = liftoffRead.mock.calls.length

    rerender({ streaming: true })
    await waitFor(() => expect(result.current.isWorking).toBe(false))
    expect(liftoffRead.mock.calls.length).toBe(callsBefore)
  })

  it('asks nothing until there is a tenant and a conversation', async () => {
    const { rerender } = renderHook(
      (props: { threadId: string | null }) => useThreadContinuation('liftoff', {
        tenantId: undefined, threadId: props.threadId, isStreaming: false,
      }),
      { wrapper: makeWrapper().wrapper, initialProps: { threadId: null as string | null } },
    )
    rerender({ threadId: THREAD })
    await new Promise((r) => setTimeout(r, 10))
    expect(liftoffRead).not.toHaveBeenCalled()
  })
})
