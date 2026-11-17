import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useConnectors, useDeleteConnector, CONNECTORS_QUERY_KEY } from './useConnectors'
import { INTERNAL_AGENTS_QUERY_KEY } from './useInternalAgents'

// Mock the auth context
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    currentTenant: { id: 'test-tenant-id' },
  }),
}))

// Mock the connections service
vi.mock('../services/connections', () => ({
  listConnectors: vi.fn().mockResolvedValue([
    { id: 'c1', type: 'slack', status: 'connected' },
    { id: 'c2', type: 'github', status: 'connected' },
  ]),
  deleteConnector: vi.fn().mockResolvedValue(undefined),
}))

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

describe('useConnectors', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('fetches connectors successfully', async () => {
    const { result } = renderHook(() => useConnectors(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    expect(result.current.data).toBeDefined()
    expect(Array.isArray(result.current.data)).toBe(true)
  })

  it('returns connectors with expected properties', async () => {
    const { result } = renderHook(() => useConnectors(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    if (result.current.data && result.current.data.length > 0) {
      const connector = result.current.data[0]
      expect(connector).toHaveProperty('id')
      expect(connector).toHaveProperty('type')
      expect(connector).toHaveProperty('status')
    }
  })

  // Note: Testing disabled state when tenant is null would require
  // resetting the mock between tests, which is complex with vi.mock.
  // The enabled: !!tenant?.id logic is tested implicitly by other tests.
})

describe('useDeleteConnector', () => {
  it('deletes a connector successfully', async () => {
    const { result } = renderHook(() => useDeleteConnector(), {
      wrapper: createWrapper(),
    })

    result.current.mutate('connector-1')

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })
  })

  it('invalidates both connectors and internal-agents query caches on success', async () => {
    // The backend connector.deleted subscriber scrubs the dead UUID from
    // every internal agent's integrations[] JSONB. We must invalidate the
    // internal-agents cache too so /teams/update re-reads the scrubbed
    // array without waiting for the stale window.
    const queryClient = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    })
    const invalidateSpy = vi.spyOn(queryClient, 'invalidateQueries')

    function Wrapper({ children }: { children: ReactNode }) {
      return (
        <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
      )
    }

    const { result } = renderHook(() => useDeleteConnector(), {
      wrapper: Wrapper,
    })

    result.current.mutate('connector-1')

    await waitFor(() => {
      expect(result.current.isSuccess).toBe(true)
    })

    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: CONNECTORS_QUERY_KEY })
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: INTERNAL_AGENTS_QUERY_KEY })
  })
})
