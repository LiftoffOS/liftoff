import type { ReactNode } from 'react'
import { renderHook, waitFor } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useLiftoffScore } from './useLiftoffScore'
import { getLiftoffScore } from '../services/liftoffScore'
import type { LiftoffScoreResponse } from '../types/liftoffScore'

vi.mock('./useTenant', () => ({
  useTenant: () => ({ currentTenant: { id: 'tenant-abc' } }),
}))

let mockCanManageMembers = true
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({ canManageMembers: () => mockCanManageMembers }),
}))

let mockFlagEnabled = true
vi.mock('../contexts/FeatureFlagsContext', () => ({
  useFeatureFlags: () => ({ liftoffScoreEnabled: mockFlagEnabled }),
}))

vi.mock('../services/liftoffScore', () => ({ getLiftoffScore: vi.fn() }))

const payload: LiftoffScoreResponse = {
  period: 'this_month', status: 'ok', taskCount: 214,
  computedAt: '2026-08-23T04:00:11Z', groups: [], entries: [],
}

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  )
}

describe('useLiftoffScore', () => {
  beforeEach(() => {
    mockCanManageMembers = true
    mockFlagEnabled = true
    vi.mocked(getLiftoffScore).mockReset()
    vi.mocked(getLiftoffScore).mockResolvedValue(payload)
  })

  it('fetches for an admin with the flag on', async () => {
    const { result } = renderHook(() => useLiftoffScore('this_month'), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.scores).toBeDefined())
    expect(getLiftoffScore).toHaveBeenCalledWith('tenant-abc', 'this_month')
  })

  it('does not fetch for a non-admin', async () => {
    mockCanManageMembers = false
    const { result } = renderHook(() => useLiftoffScore('this_month'), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(getLiftoffScore).not.toHaveBeenCalled()
  })

  it('does not fetch when the flag is off', async () => {
    mockFlagEnabled = false
    const { result } = renderHook(() => useLiftoffScore('this_month'), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(getLiftoffScore).not.toHaveBeenCalled()
  })

  it('does not fetch when the caller gates it off', async () => {
    const { result } = renderHook(() => useLiftoffScore('this_month', { enabled: false }), { wrapper: createWrapper() })
    await waitFor(() => expect(result.current.isLoading).toBe(false))
    expect(getLiftoffScore).not.toHaveBeenCalled()
  })
})
