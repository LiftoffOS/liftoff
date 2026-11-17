// One query and one marker behind three indicators. What matters here is that
// marking a thread read invalidates BOTH cache entries: the tenant-wide counts
// that drive the two badges, and that team's thread list that draws the row
// dot. Clearing one and not the other is worse than clearing neither, because
// the surfaces then contradict each other.
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import * as agentChatService from '../services/agentChat'

vi.mock('./useTenant', () => ({
  useTenant: () => ({ currentTenant: { id: 'tenant-abc' } }),
}))

vi.mock('../services/agentChat', async () => {
  const actual = await vi.importActual<typeof import('../services/agentChat')>(
    '../services/agentChat',
  )
  return {
    ...actual,
    getAgentChatUnreadCounts: vi.fn(),
    markAgentChatThreadRead: vi.fn(),
  }
})

import { useChatUnreadCounts, useMarkThreadRead, CHAT_UNREAD_QUERY_KEY } from './useChatUnread'
import { AGENT_CHAT_THREADS_QUERY_KEY } from './useAgentChatThreads'

let queryClient: QueryClient

function createWrapper() {
  queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useChatUnreadCounts', () => {
  it('returns the counts map for the current tenant', async () => {
    vi.mocked(agentChatService.getAgentChatUnreadCounts).mockResolvedValue({
      counts: { 'agent-1': 3 },
    })

    const { result } = renderHook(() => useChatUnreadCounts(), { wrapper: createWrapper() })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.data).toEqual({ 'agent-1': 3 })
    expect(agentChatService.getAgentChatUnreadCounts).toHaveBeenCalledWith('tenant-abc')
  })

  it('defaults to an empty map rather than undefined', async () => {
    vi.mocked(agentChatService.getAgentChatUnreadCounts).mockResolvedValue(
      {} as agentChatService.UnreadCountsResponse,
    )

    const { result } = renderHook(() => useChatUnreadCounts(), { wrapper: createWrapper() })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.data).toEqual({})
  })
})

describe('useMarkThreadRead', () => {
  it('invalidates the counts AND that team\'s thread list', async () => {
    vi.mocked(agentChatService.markAgentChatThreadRead).mockResolvedValue(undefined)

    const wrapper = createWrapper()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    const { result } = renderHook(() => useMarkThreadRead('agent-1'), { wrapper })
    result.current.mutate('thread-1')

    await waitFor(() => expect(result.current.isSuccess).toBe(true))

    expect(agentChatService.markAgentChatThreadRead).toHaveBeenCalledWith(
      'tenant-abc', 'agent-1', 'thread-1',
    )
    expect(invalidate).toHaveBeenCalledWith({ queryKey: CHAT_UNREAD_QUERY_KEY })
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: [...AGENT_CHAT_THREADS_QUERY_KEY, 'agent-1', 'tenant-abc'],
    })
  })

  it('invalidates nothing when the call fails, so the dots stay honest', async () => {
    vi.mocked(agentChatService.markAgentChatThreadRead).mockRejectedValue(new Error('nope'))

    const wrapper = createWrapper()
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries')

    const { result } = renderHook(() => useMarkThreadRead('agent-1'), { wrapper })
    result.current.mutate('thread-1')

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(invalidate).not.toHaveBeenCalled()
  })
})
