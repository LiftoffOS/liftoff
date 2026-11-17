// The queue's optimistic updates, which every decision mutation shares.
//
// They used to carry a copy each, addressing a cache key spelled out by hand
// and ending in the literal 'pending'. A copy is where another definition of
// the queue starts, and a hand-spelled key is a write that silently lands
// nowhere the day the key changes. These tests pin the shared behaviour:
// the item leaves every cached view, the right bucket is decremented, and a
// failed request puts everything back.

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, act, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider, type InfiniteData } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import {
  approvalsQueryKey,
  pendingCountQueryKey,
  useApproveRequest,
  usePendingApprovalCount,
  useRespondToClarification,
} from './useOversight'
import type { PaginatedApprovalsResponse } from '../services/oversight'

const TENANT = 'test-tenant-id'

const approveMock = vi.fn()
const respondToClarificationMock = vi.fn()
const getPendingCountMock = vi.fn()

vi.mock('../services/oversight', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../services/oversight')>()
  return {
    ...actual,
    approveRequest: (...args: unknown[]) => approveMock(...args),
    respondToClarification: (...args: unknown[]) => respondToClarificationMock(...args),
    getPendingCount: (...args: unknown[]) => getPendingCountMock(...args),
  }
})

vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ currentTenant: { id: TENANT, name: 'Test' } }),
}))

vi.mock('../lib/analytics', () => ({ track: vi.fn() }))

const criticalApproval = {
  kind: 'approval' as const,
  id: 'apr_1',
  tenantId: TENANT,
  agentId: 'agent_1',
  hitlLevel: 2,
  pendingToolCalls: [],
  reason: 'super_destructive_gate' as const,
  status: 'pending' as const,
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
}

const clarification = {
  kind: 'clarification' as const,
  id: 'clar_1',
  tenantId: TENANT,
  agentId: 'agent_2',
  threadId: 'thread_1',
  question: 'Which sheet should I write to?',
  source: 'recovery_llm' as const,
  vendorRequestId: null,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 3600_000).toISOString(),
}

const counts = {
  total: 2,
  approvalsStandard: 0,
  approvalsCritical: 1,
  approvalsOther: 0,
  clarifications: 1,
}

function seededClient() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })

  const page: PaginatedApprovalsResponse = {
    items: [criticalApproval, clarification],
    cursor: null,
    hasMore: false,
    total: counts.total,
    counts,
  }
  queryClient.setQueryData<InfiniteData<PaginatedApprovalsResponse>>(
    approvalsQueryKey(TENANT),
    { pages: [page], pageParams: [undefined] },
  )
  queryClient.setQueryData(pendingCountQueryKey(TENANT), { count: counts.total, ...counts })

  return queryClient
}

function wrapperFor(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  }
}

const listOf = (queryClient: QueryClient) =>
  queryClient.getQueryData<InfiniteData<PaginatedApprovalsResponse>>(approvalsQueryKey(TENANT))

const countOf = (queryClient: QueryClient) =>
  queryClient.getQueryData<Record<string, number>>(pendingCountQueryKey(TENANT))

beforeEach(() => {
  vi.clearAllMocks()
})

describe('optimistic queue updates', () => {
  it('takes an approved item out of the list and off its bucket', async () => {
    approveMock.mockResolvedValue({})
    const queryClient = seededClient()
    const { result } = renderHook(() => useApproveRequest(), { wrapper: wrapperFor(queryClient) })

    act(() => result.current.mutate({ approvalId: 'apr_1' }))

    await waitFor(() => {
      expect(listOf(queryClient)?.pages[0].items.map(i => i.id)).toEqual(['clar_1'])
    })
    expect(listOf(queryClient)?.pages[0].counts).toMatchObject({
      total: 1,
      approvalsCritical: 0,
      clarifications: 1,
    })
    expect(countOf(queryClient)).toMatchObject({ count: 1, total: 1, approvalsCritical: 0 })
  })

  it('decrements the clarification bucket when a question is answered', async () => {
    respondToClarificationMock.mockResolvedValue(undefined)
    const queryClient = seededClient()
    const { result } = renderHook(() => useRespondToClarification(), { wrapper: wrapperFor(queryClient) })

    act(() => result.current.mutate({ clarificationId: 'clar_1', response: 'Use the Q3 sheet' }))

    await waitFor(() => {
      expect(listOf(queryClient)?.pages[0].items.map(i => i.id)).toEqual(['apr_1'])
    })
    expect(countOf(queryClient)).toMatchObject({ total: 1, clarifications: 0, approvalsCritical: 1 })
  })

  it('removes the item from an agent-scoped view as well as the unscoped one', async () => {
    respondToClarificationMock.mockResolvedValue(undefined)
    const queryClient = seededClient()
    queryClient.setQueryData<InfiniteData<PaginatedApprovalsResponse>>(
      approvalsQueryKey(TENANT, 'agent_2'),
      {
        pages: [{ items: [clarification], cursor: null, hasMore: false, total: 1, counts: { ...counts, total: 1, approvalsCritical: 0 } }],
        pageParams: [undefined],
      },
    )
    const { result } = renderHook(() => useRespondToClarification(), { wrapper: wrapperFor(queryClient) })

    act(() => result.current.mutate({ clarificationId: 'clar_1', response: 'Use the Q3 sheet' }))

    await waitFor(() => {
      const scoped = queryClient.getQueryData<InfiniteData<PaginatedApprovalsResponse>>(
        approvalsQueryKey(TENANT, 'agent_2'),
      )
      expect(scoped?.pages[0].items).toHaveLength(0)
    })
  })

  it('puts the item back when the request fails', async () => {
    approveMock.mockRejectedValue(new Error('nope'))
    const queryClient = seededClient()
    const { result } = renderHook(() => useApproveRequest(), { wrapper: wrapperFor(queryClient) })

    act(() => result.current.mutate({ approvalId: 'apr_1' }))

    await waitFor(() => expect(result.current.isError).toBe(true))
    expect(listOf(queryClient)?.pages[0].items.map(i => i.id)).toEqual(['apr_1', 'clar_1'])
    expect(listOf(queryClient)?.pages[0].counts).toMatchObject(counts)
    expect(countOf(queryClient)).toMatchObject({ count: 2, total: 2 })
  })

  it('reads a backend that sends only `count`, so this deploy is not gated on that one', async () => {
    // Until the backend ships the breakdown it answers with a single number.
    // The total has to come through anyway, or every surface reads "unknown"
    // while the backend is telling it the truth.
    getPendingCountMock.mockResolvedValue({ count: 141 })
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } })
    const { result } = renderHook(() => usePendingApprovalCount(), {
      wrapper: wrapperFor(queryClient),
    })

    await waitFor(() => expect(result.current.data).toBeDefined())
    expect(result.current.data?.total).toBe(141)
  })

  it('leaves an unknown count alone rather than decrementing null into a number', async () => {
    respondToClarificationMock.mockResolvedValue(undefined)
    const queryClient = seededClient()
    queryClient.setQueryData(pendingCountQueryKey(TENANT), { count: null })
    const { result } = renderHook(() => useRespondToClarification(), { wrapper: wrapperFor(queryClient) })

    act(() => result.current.mutate({ clarificationId: 'clar_1', response: 'Use the Q3 sheet' }))

    await waitFor(() => {
      expect(listOf(queryClient)?.pages[0].items.map(i => i.id)).toEqual(['apr_1'])
    })
    expect(countOf(queryClient)).toEqual({ count: null })
  })
})
