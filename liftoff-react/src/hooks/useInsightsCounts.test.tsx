import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'

import * as insightsService from '../services/insights'

vi.mock('./useTenant', () => ({
  useTenant: () => ({ currentTenant: { id: 'tenant-abc' } }),
}))

vi.mock('../services/insights', async () => {
  const actual = await vi.importActual<typeof import('../services/insights')>(
    '../services/insights',
  )
  return {
    ...actual,
    getInsightsCounts: vi.fn(),
  }
})

import { useInsightsCounts } from './useInsightsCounts'

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  })
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    )
  }
}

beforeEach(() => {
  vi.clearAllMocks()
})

describe('useInsightsCounts', () => {
  it('returns counts payload from getInsightsCounts', async () => {
    vi.mocked(insightsService.getInsightsCounts).mockResolvedValue({
      agentCount: 2,
      invocationCount: 0,
      auditCount: 0,
      isEmpty: false,
    })

    const { result } = renderHook(() => useInsightsCounts(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.counts).toEqual({
      agentCount: 2,
      invocationCount: 0,
      auditCount: 0,
      isEmpty: false,
    })
    expect(insightsService.getInsightsCounts).toHaveBeenCalledWith('tenant-abc')
  })

  it('reports isEmpty=true for a brand-new tenant', async () => {
    vi.mocked(insightsService.getInsightsCounts).mockResolvedValue({
      agentCount: 0,
      invocationCount: 0,
      auditCount: 0,
      isEmpty: true,
    })

    const { result } = renderHook(() => useInsightsCounts(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(result.current.counts?.isEmpty).toBe(true)
  })
})
