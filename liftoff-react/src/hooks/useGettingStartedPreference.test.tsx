import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, waitFor, act } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { useGettingStartedPreference, GETTING_STARTED_HIDDEN_KEY } from './useGettingStartedPreference'

const MIGRATION_VERSION_KEY = 'liftoff_getting_started_v2_migrated'

// Mock account state
let mockAccount: { preferences?: { gettingStartedHidden?: boolean } } | null = null
const mockUpdateAccount = vi.fn()
const mockRefreshAccount = vi.fn()

// Mock the auth context
vi.mock('../contexts/AuthContext', () => ({
  useAuth: () => ({
    account: mockAccount,
    refreshAccount: mockRefreshAccount,
  }),
}))

// Mock useUpdateAccount hook
vi.mock('./useAccount', () => ({
  useUpdateAccount: () => ({
    mutateAsync: mockUpdateAccount,
    isPending: false,
  }),
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

describe('useGettingStartedPreference', () => {
  beforeEach(() => {
    localStorage.clear()
    sessionStorage.clear()
    vi.clearAllMocks()
    mockAccount = { preferences: {} }
    mockUpdateAccount.mockResolvedValue({})
  })

  it('returns isHidden=false when no preference set', () => {
    const { result } = renderHook(() => useGettingStartedPreference(), {
      wrapper: createWrapper(),
    })

    expect(result.current.isHidden).toBe(false)
  })

  it('returns isHidden=true when backend has gettingStartedHidden=true', () => {
    mockAccount = { preferences: { gettingStartedHidden: true } }

    const { result } = renderHook(() => useGettingStartedPreference(), {
      wrapper: createWrapper(),
    })

    expect(result.current.isHidden).toBe(true)
  })

  it('returns isHidden=true when localStorage has value (fallback)', () => {
    localStorage.setItem(GETTING_STARTED_HIDDEN_KEY, 'true')

    const { result } = renderHook(() => useGettingStartedPreference(), {
      wrapper: createWrapper(),
    })

    expect(result.current.isHidden).toBe(true)
  })

  it('returns isLoading=true when account is null', () => {
    mockAccount = null

    const { result } = renderHook(() => useGettingStartedPreference(), {
      wrapper: createWrapper(),
    })

    expect(result.current.isLoading).toBe(true)
  })

  it('persists to localStorage immediately on hideGettingStarted', async () => {
    const { result } = renderHook(() => useGettingStartedPreference(), {
      wrapper: createWrapper(),
    })

    await act(async () => {
      await result.current.hideGettingStarted()
    })

    expect(localStorage.getItem(GETTING_STARTED_HIDDEN_KEY)).toBe('true')
  })

  it('calls updateAccount with correct preferences payload', async () => {
    const { result } = renderHook(() => useGettingStartedPreference(), {
      wrapper: createWrapper(),
    })

    await act(async () => {
      await result.current.hideGettingStarted()
    })

    expect(mockUpdateAccount).toHaveBeenCalledWith({
      preferences: { gettingStartedHidden: true }
    })
  })

  it('handles API errors gracefully without rollback', async () => {
    mockUpdateAccount.mockRejectedValue(new Error('API Error'))
    const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const { result } = renderHook(() => useGettingStartedPreference(), {
      wrapper: createWrapper(),
    })

    await act(async () => {
      await result.current.hideGettingStarted()
    })

    // localStorage should still be set (graceful degradation)
    expect(localStorage.getItem(GETTING_STARTED_HIDDEN_KEY)).toBe('true')
    expect(consoleSpy).toHaveBeenCalled()

    consoleSpy.mockRestore()
  })

  it('migrates localStorage value to backend on first load', async () => {
    localStorage.setItem(GETTING_STARTED_HIDDEN_KEY, 'true')
    mockAccount = { preferences: {} }

    renderHook(() => useGettingStartedPreference(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(mockUpdateAccount).toHaveBeenCalledWith({
        preferences: { gettingStartedHidden: true }
      })
    })
  })

  it('skips migration if already migrated (version flag)', async () => {
    localStorage.setItem(GETTING_STARTED_HIDDEN_KEY, 'true')
    localStorage.setItem(MIGRATION_VERSION_KEY, 'true')
    mockAccount = { preferences: {} }

    renderHook(() => useGettingStartedPreference(), {
      wrapper: createWrapper(),
    })

    // Wait a bit to ensure no migration happens
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(mockUpdateAccount).not.toHaveBeenCalled()
  })

  it('skips migration if backend already has preference', async () => {
    localStorage.setItem(GETTING_STARTED_HIDDEN_KEY, 'true')
    mockAccount = { preferences: { gettingStartedHidden: true } }

    renderHook(() => useGettingStartedPreference(), {
      wrapper: createWrapper(),
    })

    await waitFor(() => {
      expect(localStorage.getItem(MIGRATION_VERSION_KEY)).toBe('true')
    })

    // Should set migration flag but not call updateAccount
    expect(mockUpdateAccount).not.toHaveBeenCalled()
  })
})
